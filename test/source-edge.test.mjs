import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startMockSource} from './mock-source.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

async function withArchive(run) {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  try { await run(directory); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

const objectRoute = (object, version, text, status = 200) => ({
  path: `/object/${object}?version=${version}`,
  status,
  body: status === 200 ? {text} : {error: 'changed'},
});

test('链接链、深层循环与越界链接都留下缺口，且不向上层站点发请求', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'docs', kind: 'dir', object: 'd1', version: 'v1'},
      {path: 'chain', kind: 'link', target: 'docs'},
      {path: 'up', kind: 'link', target: '../../etc'},
      {path: 'absolute', kind: 'link', target: '/etc/passwd'},
    ]}},
    {path: '/directory?path=docs', status: 200, body: {clear: true, entries: [
      {path: 'docs/back', kind: 'link', target: '..'},
      {path: 'docs/note.txt', kind: 'file', object: 'o9', version: 'v1'},
    ]}},
    {path: '/directory?path=chain', status: 200, body: {clear: true, entries: [
      {path: 'chain/note.txt', kind: 'file', object: 'o9', version: 'v1'},
    ]}},
    objectRoute('o9', 'v1', 'note body'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      const record = result.records.find(item => item.object === 'o9');
      assert.ok(record, '链接入口下的文件仍要归属到同一对象');
      assert.deepEqual(record.aliases, ['chain/note.txt', 'docs/note.txt']);
      assert.equal(record.evidence.length, 1, '同一对象版本只读取一次正文');
      assert.equal(result.complete, false);
      const codes = result.issues.map(issue => issue.code);
      assert.ok(codes.includes('source.link-cycle'), 'docs/back 指回根层构成循环');
      assert.ok(codes.includes('source.link-outside-root'));
      assert.equal(codes.filter(code => code === 'source.link-outside-root').length, 2);
      for (const request of source.requests()) {
        assert.ok(!request.path.includes('etc') && !request.path.includes('passwd'));
        assert.ok(!request.path.includes('..'));
      }
    } finally { await source.close(); }
  });
});

test('断链记录可复核缺口，不影响兄弟条目的完整接收', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'missing', kind: 'link', target: 'ghost/folder'},
      {path: 'keep.txt', kind: 'file', object: 'ok1', version: 'v1'},
    ]}},
    objectRoute('ok1', 'v1', 'kept'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(result.complete, false);
      assert.ok(result.issues.some(issue => issue.code === 'source.link-broken' && issue.detail.path === 'missing'));
      assert.ok(result.records.some(record => record.object === 'ok1'));
    } finally { await source.close(); }
  });
});

test('后续扫描区分路径消失与对象不再被任何路径引用', async () => {
  const firstTree = {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
    {path: 'old.txt', kind: 'file', object: 'gone', version: 'v1'},
    {path: 'move.txt', kind: 'file', object: 'moved', version: 'v1'},
  ]}};
  const secondTree = {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g2', clear: true, entries: [
    {path: 'archive/move.txt', kind: 'file', object: 'moved', version: 'v2'},
  ]}};
  const routes = [
    firstTree,
    objectRoute('gone', 'v1', 'old content'),
    objectRoute('moved', 'v1', 'moving content'),
    secondTree,
    objectRoute('moved', 'v2', 'moving content v2'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(first.complete, true);
      const reopened = await openArchive(directory);
      const second = await collect({baseUrl: source.baseUrl, archive: reopened, mode: 'source'});
      const removed = second.records.filter(record => record.kind === 'path-removed');
      assert.deepEqual(removed.map(record => record.path).sort(), ['move.txt', 'old.txt']);
      const unreferenced = second.records.filter(record => record.kind === 'object-unreferenced');
      assert.deepEqual(unreferenced.map(record => record.object), ['gone']);
      const moved = second.records.find(record => record.object === 'moved' && !record.kind);
      assert.deepEqual(moved.aliases, ['archive/move.txt']);
      assert.equal(second.complete, true, '已确认根清点时路径消失不是未决缺口');
      const persisted = await openArchive(directory);
      assert.ok(persisted.snapshot().records.some(record => record.id === 'source-object-unreferenced:gone'));
    } finally { await source.close(); }
  });
});

test('目录清点失败时路径消失不得确认，只能留下变动缺口', async () => {
  const firstTree = {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
    {path: 'folder', kind: 'dir', object: 'd1', version: 'v1'},
  ]}};
  const routes = [
    firstTree,
    {path: '/directory?path=folder', status: 200, body: {clear: true, entries: [
      {path: 'folder/inside.txt', kind: 'file', object: 'inner', version: 'v1'},
    ]}},
    objectRoute('inner', 'v1', 'inside'),
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g2', clear: true, entries: [
      {path: 'folder', kind: 'dir', object: 'd1', version: 'v2'},
    ]}},
    {path: '/directory?path=folder', status: 500, body: {error: 'boom'}},
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(second.complete, false);
      assert.ok(second.issues.some(issue => issue.code === 'source.directory-unavailable'));
      assert.ok(second.issues.some(issue => issue.code === 'source.change-unconfirmed' && issue.detail.path === 'folder/inside.txt'));
      assert.equal(second.records.some(record => record.kind === 'path-removed'), false);
    } finally { await source.close(); }
  });
});

test('412版本冲突不产生记录、不存正文，旧内容绝不挂到新对象名下', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g2', clear: true, entries: [
      {path: 'a.txt', kind: 'file', object: 'o1', version: 'v2'},
      {path: 'b.txt', kind: 'file', object: 'safe', version: 'v1'},
    ]}},
    objectRoute('o1', 'v2', null, 412),
    objectRoute('safe', 'v1', 'independent'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(result.records.some(record => record.object === 'o1'), false);
      assert.ok(result.issues.some(issue => issue.code === 'source.object-version-conflict'));
      assert.ok(result.records.some(record => record.object === 'safe'));
      const persisted = await openArchive(directory);
      const objectReceipts = persisted.snapshot().evidence.filter(item => item.url.includes('/object/'));
      assert.deepEqual(objectReceipts.map(item => item.status), [200], '412冲突不产生原文证据，安全独立部分保留');
      const bytes = await persisted.raw(objectReceipts[0].hash);
      assert.ok(bytes.toString('utf8').includes('independent'));
    } finally { await source.close(); }
  });
});

test('同一对象多版本并存记为未决缺口，正文仍按版本分别只取一次', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'new.txt', kind: 'file', object: 'dual', version: 'v2'},
      {path: 'old.txt', kind: 'file', object: 'dual', version: 'v1'},
    ]}},
    objectRoute('dual', 'v2', 'second'),
    objectRoute('dual', 'v1', 'first'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.ok(result.issues.some(issue => issue.code === 'source.object-version-split'));
      assert.equal(result.complete, false);
      const record = result.records.find(item => item.object === 'dual');
      assert.deepEqual(record.aliases, ['new.txt', 'old.txt']);
      assert.deepEqual(record.versions, ['v1', 'v2']);
      const objectRequests = source.requests().filter(request => request.path.startsWith('/object/'));
      assert.equal(objectRequests.length, 2);
    } finally { await source.close(); }
  });
});

test('根未声明clear时扫描不完整；空的有效200正文与错误状态区分', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: false, entries: [
      {path: 'empty.bin', kind: 'file', object: 'empty', version: 'v1'},
      {path: 'broken.txt', kind: 'file', object: 'broken', version: 'v1'},
    ]}},
    {path: '/object/empty?version=v1', status: 200, body: Buffer.alloc(0)},
    {path: '/object/broken?version=v1', status: 500, body: {error: 'fail'}},
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(result.complete, false);
      assert.ok(result.issues.some(issue => issue.code === 'source.root-not-clear'));
      const empty = result.records.find(record => record.object === 'empty');
      assert.ok(empty, '空的有效结果仍是合法对象');
      assert.ok(result.issues.some(issue => issue.code === 'source.object-unavailable'));
      assert.equal(result.records.some(record => record.object === 'broken'), false);
    } finally { await source.close(); }
  });
});

test('重复扫描不产生重复记录修订，且来源结果经真实HTTP归档可重开读取', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'a.txt', kind: 'file', object: 'stable', version: 'v1'},
    ]}},
    objectRoute('stable', 'v1', 'same bytes'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      const persisted = await openArchive(directory);
      const objectRecords = persisted.snapshot().records.filter(record => record.id === 'source-object:stable');
      assert.equal(objectRecords.length, 1);
      const objectReceipts = persisted.snapshot().evidence.filter(item => item.url.includes('/object/'));
      assert.ok(objectReceipts.length >= 1);
      const raw = JSON.parse((await persisted.raw(objectReceipts[0].hash)).toString('utf8'));
      assert.equal(raw.text, 'same bytes');
    } finally { await source.close(); }
  });
});

test('目录链接下的嵌套目录保留链接入口逻辑路径，且目标目录资料只清点一次', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'real', kind: 'dir', object: 'd1', version: 'v1'},
      {path: 'gate', kind: 'link', target: 'real'},
    ]}},
    {path: '/directory?path=real', status: 200, body: {clear: true, entries: [
      {path: 'real/inner', kind: 'dir', object: 'd2', version: 'v1'},
    ]}},
    {path: '/directory?path=real/inner', status: 200, body: {clear: true, entries: [
      {path: 'real/inner/f.txt', kind: 'file', object: 'deep', version: 'v1'},
    ]}},
    {path: '/directory?path=gate', status: 200, body: {clear: true, entries: [
      {path: 'gate/inner', kind: 'dir', object: 'd2', version: 'v1'},
    ]}},
    {path: '/directory?path=gate/inner', status: 200, body: {clear: true, entries: [
      {path: 'gate/inner/f.txt', kind: 'file', object: 'deep', version: 'v1'},
    ]}},
    objectRoute('deep', 'v1', 'deep body'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      const record = result.records.find(item => item.object === 'deep');
      assert.deepEqual(record.aliases, ['gate/inner/f.txt', 'real/inner/f.txt']);
      assert.equal(result.evidenceCount, 1, '同一对象正文只接收一次');
      const realListing = source.requests().filter(request => {
        const path = new URL(request.path, 'http://localhost').searchParams.get('path') ?? '';
        return path === 'real/inner';
      }).length;
      assert.equal(realListing, 1, '真实目标目录不重复清点');
    } finally { await source.close(); }
  });
});

test('异常来源产生过多请求时扫描截断，保留已收部分并声明不完整', async () => {
  // 每个目录都再报一个同名子目录，制造不断增长的目录链。
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'd0', kind: 'dir', object: 'dir0', version: 'v1'},
      {path: 'seed.txt', kind: 'file', object: 'seed', version: 'v1'},
    ]}},
    objectRoute('seed', 'v1', 'seed body'),
  ];
  // 动态目录响应：dN 永远再列出 d(N+1)，且没有 clear 标记。
  const dynamic = async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/tree') {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify(routes[0].body));
      return;
    }
    if (url.pathname === '/object/seed') {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({text: 'seed body'}));
      return;
    }
    const match = url.searchParams.get('path')?.match(/(?:^|\/)d(\d+)$/);
    if (match) {
      const parent = url.searchParams.get('path');
      const next = Number(match[1]) + 1;
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({clear: false, entries: [
        {path: `${parent}/d${next}`, kind: 'dir', object: `dir${next}`, version: 'v1'},
      ]}));
      return;
    }
    response.writeHead(404).end();
  };
  const {createServer} = await import('node:http');
  const server = createServer(dynamic);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await withArchive(async directory => {
    try {
      const result = await collect({
        baseUrl, archive: await openArchive(directory), mode: 'source', maxRequests: 8,
      });
      assert.equal(result.complete, false);
      assert.ok(result.issues.some(issue => issue.code === 'source.scan-truncated'));
      // 截断前已发现的归属仍保留在账本里，不把部分扫描伪装成完整结果。
      assert.equal(result.membership.paths['seed.txt'], 'seed');
      assert.ok(Object.keys(result.membership.paths).length >= 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
    }
  });
});

test('链接链（链接指向另一个链接）按波次解析，最终文件归属全部保留', async () => {
  // first -> second -> real 是一条链接链；real 与 first 在同一波次未必都已就绪，
  // 扫描需跨波次推进，不能把可解析的链接链误判成断链。
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'real', kind: 'dir', object: 'd1', version: 'v1'},
      {path: 'second', kind: 'link', target: 'real'},
      {path: 'first', kind: 'link', target: 'second'},
    ]}},
    {path: '/directory?path=real', status: 200, body: {clear: true, entries: [
      {path: 'real/doc.txt', kind: 'file', object: 'chaindoc', version: 'v1'},
    ]}},
    {path: '/directory?path=second', status: 200, body: {clear: true, entries: [
      {path: 'second/doc.txt', kind: 'file', object: 'chaindoc', version: 'v1'},
    ]}},
    {path: '/directory?path=first', status: 200, body: {clear: true, entries: [
      {path: 'first/doc.txt', kind: 'file', object: 'chaindoc', version: 'v1'},
    ]}},
    objectRoute('chaindoc', 'v1', 'chain body'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(result.issues.some(issue => issue.code === 'source.link-broken'), false);
      assert.equal(result.issues.some(issue => issue.code === 'source.link-cycle'), false);
      const record = result.records.find(item => item.object === 'chaindoc');
      assert.deepEqual(record.aliases, ['first/doc.txt', 'real/doc.txt', 'second/doc.txt']);
      assert.equal(result.evidenceCount, 1, '链接链各入口共享同一对象正文');
    } finally { await source.close(); }
  });
});

test('链接目标含反斜杠或空目标时被拒绝为不可解释，不发越界请求', async () => {
  const routes = [
    {path: '/tree', status: 200, body: {root: 'authorized', generation: 'g1', clear: true, entries: [
      {path: 'bad1', kind: 'link', target: 'a\\..\\b'},
      {path: 'bad2', kind: 'link', target: ''},
      {path: 'ok.txt', kind: 'file', object: 'fine', version: 'v1'},
    ]}},
    objectRoute('fine', 'v1', 'fine body'),
  ];
  await withArchive(async directory => {
    const source = await startMockSource(routes);
    try {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.equal(result.complete, false);
      const outside = result.issues.filter(issue => issue.code === 'source.link-outside-root');
      assert.equal(outside.length, 2);
      assert.ok(result.records.some(record => record.object === 'fine'));
      for (const request of source.requests()) assert.ok(!request.path.includes('\\'));
    } finally { await source.close(); }
  });
});
