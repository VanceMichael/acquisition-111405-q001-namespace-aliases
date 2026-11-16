import {createServer} from 'node:http';

/*
 * 最小本地资料来源：仅实现契约中 GET /tree、GET /directory、GET /object 子集，
 * 按 path 精确匹配，连续相同请求按数组次序变化，最后一次保持。与 provider 的夹具隔离。
 */
export async function startMockSource(routes) {
  const requests = [];
  const byKey = new Map();
  for (const route of routes) {
    const key = `${route.method ?? 'GET'} ${route.path}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(route);
  }
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      // 采集器按规范用 URLSearchParams 编码目录路径（"/" 会变成 %2F）；
      // 匹配路由时按解码后的查询串归一，模拟真实来源对查询参数的解码行为。
      let routeKey = request.url;
      if (url.searchParams.has('path')) {
        routeKey = `${url.pathname}?path=${url.searchParams.get('path')}`;
      }
      const key = `${request.method} ${routeKey}`;
      requests.push({method: request.method, path: request.url});
      const matches = byKey.get(key);
      if (!matches) { response.writeHead(404).end('未声明的资料接口'); return; }
      const seen = requests.filter(item => item.method === request.method && item.path === request.url).length - 1;
      const selected = matches[Math.min(seen, matches.length - 1)];
      const body = selected.body;
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      response.writeHead(selected.status, {
        'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
        'content-length': payload.length,
      });
      response.end(payload);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error.message));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests.map(item => ({...item})),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
