import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {scanSource} from './source.mjs';

export async function collect({baseUrl, archive, mode = 'legacy', maxRequests}) {
  const transport = createTransport(baseUrl);
  if (mode === 'legacy') {
    const response = await transport.request('/legacy');
    if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
    const records = [normalizeLegacy(response.json())];
    await archive.commit({records, exchanges: transport.exchanges});
    return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
  }
  if (mode !== 'source') throw new Error(`不支持的来源模式：${mode}`);

  const previousMembership = archive.snapshot().membership ?? null;
  const result = await scanSource(transport, previousMembership, maxRequests ? {maxRequests} : {});
  // 原文只承认成功接收的对象正文；412/错误响应保留在问题中，绝不作为原文落盘。
  const exchanges = result.exchanges.filter(exchange =>
    !exchange.url.includes('/object/') || (exchange.status >= 200 && exchange.status < 300));
  await archive.commit({
    records: result.records,
    exchanges,
    issues: result.issues,
    membership: result.membership,
  });
  return {
    records: result.records,
    complete: result.complete,
    issues: result.issues,
    evidenceCount: result.evidenceCount,
    membership: result.membership,
  };
}
