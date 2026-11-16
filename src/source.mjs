import {digest} from './archive.mjs';

const ROOT = '';
const DEFAULT_MAX_REQUESTS = 2000;

function isString(value) {
  return typeof value === 'string';
}

/*
 * 授权根内的相对路径。只接受 POSIX 风格的根内路径：
 * 拒绝绝对路径、反斜杠、空段、"."/".." 转义。返回规范化后的段数组。
 */
function parseAuthorizedPath(value) {
  if (!isString(value) || value === '') return null;
  if (value.startsWith('/') || value.includes('\\')) return null;
  const segments = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    segments.push(segment);
  }
  return segments;
}

const joinPath = segments => segments.join('/');

/* 相对链接相对其所在的物理父目录解释；越出授权根即拒绝，绝不向上层站点发请求。 */
function resolveTarget(parentSegments, target) {
  if (!isString(target) || target === '' || target.startsWith('/') || target.includes('\\')) return null;
  const resolved = parentSegments.slice();
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
    } else resolved.push(segment);
  }
  return resolved;
}

const sortedUnique = values => [...new Set(values)].sort();

function directoryEndpoint(path) {
  const search = new URLSearchParams({path});
  return `/directory?${search.toString()}`;
}

function objectEndpoint(object, version) {
  return `/object/${encodeURIComponent(object)}?version=${encodeURIComponent(version)}`;
}

/*
 * 遍历授权资料树：目录发现、链接解释、对象读取、路径归属。
 * 同一对象的多个入口全部保留，正文按 (object, version) 只读取一次；
 * 链接仅在授权根内解释，循环/断链/无法确认的变动只产生可复核缺口。
 */
export async function scanSource(transport, previousMembership, options = {}) {
  const maxRequests = Number.isInteger(options.maxRequests) && options.maxRequests > 0
    ? options.maxRequests : DEFAULT_MAX_REQUESTS;
  const issues = [];
  const realEntries = new Map();        // 物理路径 -> 描述符
  const attributions = new Map();       // object -> {versions: Map<version, Set<path>>, paths: Set}
  const links = [];
  const dirQueue = [];
  const listedLogical = new Set();
  const confirmedDirs = new Set();
  let rootConfirmed = false;
  let generation = null;
  let requestCount = 0;
  let truncated = false;

  const addIssue = (code, message, detail = {}) => issues.push({code, message, detail});

  // 有界请求：超过上限即截断并留缺口，防止异常来源导致无限遍历。
  async function boundedRequest(endpoint) {
    if (requestCount >= maxRequests) {
      if (!truncated) addIssue('source.scan-truncated', `来源请求达到上限 ${maxRequests}，扫描已截断，结果不完整`, {});
      truncated = true;
      const error = new Error('scan truncated');
      error.truncated = true;
      throw error;
    }
    requestCount += 1;
    return transport.request(endpoint);
  }

  function attribute(object, version, logicalPath) {
    let entry = attributions.get(object);
    if (!entry) {
      entry = {versions: new Map(), paths: new Set()};
      attributions.set(object, entry);
    }
    const paths = entry.versions.get(version);
    if (paths) paths.add(logicalPath);
    else entry.versions.set(version, new Set([logicalPath]));
    entry.paths.add(logicalPath);
  }

  function acceptEntry(raw, logicalPrefix, physicalPrefix, isReal) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      addIssue('source.entry-invalid', '来源条目不是对象，已跳过', {parent: joinPath(logicalPrefix)});
      return null;
    }
    const logical = parseAuthorizedPath(raw.path);
    if (!logical) {
      addIssue('source.path-invalid', '条目路径无法在授权根内解释，已跳过', {path: isString(raw.path) ? raw.path : null});
      return null;
    }
    // 条目路径必须位于其被列出的目录之下；根清点允许来源直接给出深层相对路径。
    const withinListing = logicalPrefix.length === 0 ? true :
      logical.length === logicalPrefix.length + 1 &&
      logicalPrefix.every((part, index) => logical[index] === part);
    if (!withinListing) {
      addIssue('source.path-outside-listing', '条目路径不属于其所在目录，已跳过', {
        path: raw.path, parent: joinPath(logicalPrefix),
      });
      return null;
    }
    const descriptor = {kind: raw.kind, logical, physical: [...physicalPrefix, logical[logical.length - 1]]};
    if (raw.kind === 'file' || raw.kind === 'dir') {
      if (!isString(raw.object) || !raw.object || !isString(raw.version) || !raw.version) {
        addIssue('source.identity-invalid', '文件或目录缺少对象身份或版本，已跳过', {path: raw.path});
        return null;
      }
      descriptor.object = raw.object;
      descriptor.version = raw.version;
    } else if (raw.kind === 'link') {
      descriptor.rawTarget = isString(raw.target) ? raw.target : null;
      descriptor.target = resolveTarget(descriptor.physical.slice(0, -1), raw.target);
    } else {
      addIssue('source.kind-unknown', '条目类型未声明，无法解释，已跳过', {
        path: raw.path, kind: isString(raw.kind) ? raw.kind : null,
      });
      return null;
    }
    if (isReal) realEntries.set(joinPath(descriptor.physical), descriptor);
    return descriptor;
  }

  async function listDirectory(item) {
    const logicalKey = joinPath(item.logical);
    const response = await boundedRequest(directoryEndpoint(logicalKey));
    if (!response.ok) {
      addIssue('source.directory-unavailable', '目录清点失败，其下层归属无法确认', {path: logicalKey, status: response.status});
      return;
    }
    let payload;
    try { payload = response.json(); }
    catch {
      addIssue('source.directory-malformed', '目录响应不是有效JSON，其下层归属无法确认', {path: logicalKey});
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.entries)) {
      addIssue('source.directory-malformed', '目录响应缺少entries，其下层归属无法确认', {path: logicalKey});
      return;
    }
    if (item.real) confirmedDirs.add(joinPath(item.physical));
    if (payload.clear !== true) {
      addIssue('source.directory-not-clear', '目录未声明清点完成，可能存在未列出的子项', {path: logicalKey});
    }
    for (const raw of payload.entries) {
      // 链接入口下列出的条目，其物理路径相对链接目标(item.physical)解析。
      const descriptor = acceptEntry(raw, item.logical, item.physical, item.real);
      if (!descriptor) continue;
      const childLogicalKey = joinPath(descriptor.logical);
      if (descriptor.kind === 'file') {
        attribute(descriptor.object, descriptor.version, childLogicalKey);
      } else if (descriptor.kind === 'dir') {
        dirQueue.push({logical: descriptor.logical, physical: descriptor.physical, real: item.real});
      } else {
        links.push({
          logical: descriptor.logical,
          physicalParent: descriptor.physical.slice(0, -1),
          target: descriptor.target,
          rawTarget: descriptor.rawTarget,
          done: false,
        });
      }
    }
  }

  const records = [];
  try {
  // ---- 第一阶段：根清点 ----
  const treeResponse = await boundedRequest('/tree');
  if (!treeResponse.ok) {
    addIssue('source.tree-unavailable', `授权树清点失败（HTTP ${treeResponse.status}），本次扫描不完整`, {status: treeResponse.status});
    return finalize([], issues, transport, {generation: null, paths: {}, confirmedDirectories: []}, previousMembership, false);
  }
  let tree;
  try { tree = treeResponse.json(); }
  catch { tree = null; }
  if (!tree || typeof tree !== 'object' || Array.isArray(tree) || !isString(tree.root) || !tree.root || !Array.isArray(tree.entries)) {
    addIssue('source.tree-malformed', '授权树响应缺少root或entries，无法界定授权范围', {});
    return finalize([], issues, transport, {generation: null, paths: {}, confirmedDirectories: []}, previousMembership, false);
  }
  generation = isString(tree.generation) ? tree.generation : null;
  for (const raw of tree.entries) {
    const descriptor = acceptEntry(raw, [], [], true);
    if (!descriptor) continue;
    const logicalKey = joinPath(descriptor.logical);
    if (descriptor.kind === 'file') attribute(descriptor.object, descriptor.version, logicalKey);
    else if (descriptor.kind === 'dir') dirQueue.push({logical: descriptor.logical, physical: descriptor.physical, real: true});
    else links.push({
      logical: descriptor.logical,
      physicalParent: descriptor.physical.slice(0, -1),
      target: descriptor.target,
      rawTarget: descriptor.rawTarget,
      done: false,
    });
  }
  rootConfirmed = tree.clear === true;
  if (!rootConfirmed) addIssue('source.root-not-clear', '根目录未声明清点完成，根层可能存在未列出的路径', {root: tree.root});

  // 沿链接链找到最终落到真实目录的入口，并把链上每一个链接入口都排队清点，
  // 使每个逻辑入口（含中间链接）下的路径归属都被保留。
  function enqueueLinkMounts(terminalLink) {
    const queue = [terminalLink];
    const seen = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      const currentKey = joinPath(current.logical);
      if (seen.has(currentKey)) continue;
      seen.add(currentKey);
      if (!dirQueue.some(item => joinPath(item.logical) === currentKey)) {
        dirQueue.push({logical: current.logical, physical: current.target, real: false});
      }
      for (const upstream of links) {
        if (upstream.target !== null && joinPath(upstream.target) === currentKey) {
          queue.push(upstream);
        }
      }
    }
  }

  // ---- 第二阶段：目录 BFS 与链接波次交替推进 ----
  let progressed = true;
  while (progressed) {
    progressed = false;
    while (dirQueue.length > 0) {
      const item = dirQueue.shift();
      const logicalKey = joinPath(item.logical);
      if (listedLogical.has(logicalKey)) continue;
      listedLogical.add(logicalKey);
      progressed = true;
      await listDirectory(item);
    }
    for (const link of links) {
      if (link.done) continue;
      const logicalKey = joinPath(link.logical);
      if (link.target === null) {
        link.done = true;
        progressed = true;
        addIssue('source.link-outside-root', '链接目标越出授权根，未跟随', {path: logicalKey, target: link.rawTarget});
        continue;
      }
      const targetKey = joinPath(link.target);
      const parentKey = joinPath(link.physicalParent);
      // 目标解析到授权根本身（target 为 "." 或向上越回根）即目录循环。
      if (targetKey === '') {
        link.done = true;
        progressed = true;
        addIssue('source.link-cycle', '链接重新进入授权根，构成目录循环，已停止该入口', {
          path: logicalKey, target: targetKey,
        });
        continue;
      }
      // 目标为链接的物理父目录本身或任一祖先，即目录循环。
      if (targetKey === parentKey || parentKey.startsWith(targetKey + '/')) {
        link.done = true;
        progressed = true;
        addIssue('source.link-cycle', '链接重新进入其祖先目录，构成目录循环，已停止该入口', {
          path: logicalKey, target: targetKey,
        });
        continue;
      }
      const targetDescriptor = realEntries.get(targetKey);
      if (!targetDescriptor) continue; // 目标尚未发现：留给后续波次；最终仍缺失即断链
      link.done = true;
      progressed = true;
      if (targetDescriptor.kind === 'file') {
        attribute(targetDescriptor.object, targetDescriptor.version, logicalKey);
      } else if (targetDescriptor.kind === 'dir') {
        // 目录链接：保留链接入口下的逻辑路径，复用目标目录资料但不只保留目标路径。
        enqueueLinkMounts(link);
      }
      // 目标本身仍是链接时，由后续波次沿链接链继续解析，到达真实目录后再统一排队。
    }
  }
  for (const link of links) {
    if (link.done) continue;
    addIssue('source.link-broken', '链接目标在授权树中不存在，无法确认归属', {
      path: joinPath(link.logical), target: joinPath(link.target ?? []),
    });
  }

  // ---- 第三阶段：按 (object, version) 读取正文，多入口共享同一份原文 ----
  for (const object of [...attributions.keys()].sort()) {
    const entry = attributions.get(object);
    const versions = [...entry.versions.keys()].sort();
    if (versions.length > 1) {
      addIssue('source.object-version-split', '同一对象在本次扫描中出现多个版本，归属无法合并确认', {object, versions});
    }
    const evidence = [];
    const availableVersions = [];
    for (const version of versions) {
      const endpoint = objectEndpoint(object, version);
      const response = await boundedRequest(endpoint);
      if (response.status === 412) {
        // 版本不匹配：发现结果已过期，必须重新发现；旧内容不得挂到新对象名下，也不得当空文件。
        addIssue('source.object-version-conflict', '对象版本与来源不一致（412），需重新发现，本次不接收该对象正文', {
          object, version, paths: sortedUnique([...entry.versions.get(version)]),
        });
        continue;
      }
      if (!response.ok) {
        addIssue('source.object-unavailable', '对象正文读取失败，入口归属保留但正文缺失', {
          object, version, status: response.status, paths: sortedUnique([...entry.versions.get(version)]),
        });
        continue;
      }
      evidence.push({version, hash: digest(Buffer.from(response.bytes)), sourceUrl: endpoint, status: response.status});
      availableVersions.push(version);
    }
    if (availableVersions.length === 0) continue;
    records.push({
      id: `source-object:${object}`,
      object,
      versions: availableVersions,
      aliases: sortedUnique([...entry.paths]),
      evidence,
      generation,
    });
  }

  } catch (error) {
    if (!error?.truncated) throw error;
  }

  // ---- 第四阶段：归属账本比对，区分路径消失与对象不再被任何路径引用 ----
  const membership = {
    generation,
    paths: Object.fromEntries([...attributions.entries()].flatMap(([object, entry]) =>
      [...entry.paths].map(path => [path, object])).sort((a, b) => a[0].localeCompare(b[0]))),
    confirmedDirectories: sortedUnique([...confirmedDirs]),
    rootConfirmed,
  };
  return finalize(records, issues, transport, membership, previousMembership, true && !truncated);
}

function finalize(records, issues, transport, membership, previousMembership, scanned) {
  const previous = previousMembership && typeof previousMembership === 'object' &&
    previousMembership.paths && typeof previousMembership.paths === 'object'
    ? previousMembership
    : {paths: {}, confirmedDirectories: []};
  const previousConfirmed = new Set(Array.isArray(previous.confirmedDirectories) ? previous.confirmedDirectories : []);
  if (previous.rootConfirmed) previousConfirmed.add(ROOT);
  const currentObjects = new Set(Object.values(membership.paths));
  const changeRecords = [];
  for (const [path, object] of Object.entries(previous.paths).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (Object.hasOwn(membership.paths, path)) continue;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT;
    // 父目录必须上一轮已确认、本轮也重新清点确认；本轮清点失败时不得据缺失推断路径消失。
    const confirmedBefore = parent === ROOT ? previous.rootConfirmed === true : previousConfirmed.has(parent);
    const confirmedNow = parent === ROOT ? membership.rootConfirmed === true :
      new Set(membership.confirmedDirectories).has(parent);
    if (!confirmedBefore || !confirmedNow) {
      issues.push({
        code: 'source.change-unconfirmed',
        message: '旧路径所在目录本次未能清点，无法确认路径是否消失',
        detail: {path, object},
      });
      continue;
    }
    changeRecords.push({
      id: `source-path-removed:${path}`,
      kind: 'path-removed',
      path,
      object,
      sinceGeneration: membership.generation,
    });
    if (!currentObjects.has(object)) {
      changeRecords.push({
        id: `source-object-unreferenced:${object}`,
        kind: 'object-unreferenced',
        object,
        sinceGeneration: membership.generation,
      });
    }
  }
  records.push(...changeRecords);
  const objectFetches = transport.exchanges.filter(exchange => exchange.url.includes('/object/'));
  return {
    records,
    issues,
    exchanges: transport.exchanges,
    membership,
    complete: scanned && issues.length === 0,
    evidenceCount: objectFetches.filter(exchange => exchange.status >= 200 && exchange.status < 300).length,
  };
}
