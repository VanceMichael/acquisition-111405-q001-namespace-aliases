# 共享资料树的路径别名与对象身份采集

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查，并已接入新的授权资料树来源（`source` 模式）：自行遍历目录、解释根内链接、读取来源对象并维护路径归属。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是回归集合，验证现有摘要通路、原文摘要检查、本地来源响应、CLI 在独立进程中的真实领取、重复导入和持久归档检查，以及新来源的边界行为（链接链/循环/断链/越界、412 版本冲突、路径消失与对象失引、扫描截断等）。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中新来源的验收情景（别名、版本替换、目录链接嵌套归属）。`npm run verify:complete` 让回归集合和新来源验收同时通过。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `aliases`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-namespace-aliases:local .
docker run --rm --network none acquisition-namespace-aliases:local
docker run --rm --network none acquisition-namespace-aliases:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；`legacy` 人工摘要模式保留，新来源使用 `mode: 'source'`。
- `src/source.mjs` 的 `scanSource` 负责授权树的目录发现、链接解释、对象读取与路径归属。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分；`test/source-edge.test.mjs` 用独立的本地最小来源补充边界验证。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。

## source 模式的归属与完整性规则

- **多入口同一对象**：按来源 `object` 身份聚合，所有逻辑入口路径都保留在记录的 `aliases` 中（字典序）；正文按 `(object, version)` 只读取一次，多入口共享同一份 SHA-256 原文证据，不重复存正文，也不会因访问过一个入口而漏掉另一个项目目录的归属。
- **路径替换不串对象**：对象读取返回 412 表示发现结果已过期，本次不接收该对象正文、不落原文，并记录 `source.object-version-conflict` 缺口要求重新发现；旧内容不会挂到新对象名下，412 也不会被当成空文件。
- **链接只在授权根内解释**：相对链接相对其物理父目录解析，`..` 越根、绝对路径、反斜杠等一律拒绝（`source.link-outside-root`），不向上层站点发请求；目录循环停止该入口并记 `source.link-cycle`；目标不存在记 `source.link-broken`。目录链接下的子项保留链接入口的逻辑路径，同时复用目标目录资料，不只保留目标路径。
- **可复核的缺口**：断链、循环、越界链接、目录清点失败、未声明 `clear`、多版本并存、扫描截断等都进入 `issues`（带来源位置），任一缺口存在时 `complete=false`，已安全接收的独立部分仍保留，不把部分扫描说成完整。请求数有上限（默认 2000，可由 `collect` 的 `maxRequests` 调整），超限即截断。
- **后续扫描区分两类消失**：归档索引额外保存 `membership` 归属账本（逻辑路径→对象、已确认清点的目录、根确认标记）。下一轮比对时，已确认目录下的路径缺失生成 `path-removed` 记录；仅当该对象不再被任何路径引用时再生成 `object-unreferenced` 记录。若父目录本轮未能重新清点，则只记 `source.change-unconfirmed` 缺口，不据一次缺失推断删除。
