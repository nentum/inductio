# Inductio

> **引导进入。** 拉丁语 `inducere`（引导进入）的名词形式——投影政策把历史**引入**求值上下文，采纳政策把结果**引入**语义树。

Inductio 是 agent 语义的公理化核心：**agent 不是一个人，没有记忆；agent 是一个根节点加上挂在根上的求值历史树。**

## 核心理念

- **agent = 根 + 树**：根是引用为 null 的节点；agent 是根相同的所有节点的并集。树的生长 = 不断 append 求值结果，不是设计预演。
- **单次求值 = 一次完整的求值调用**：求值单位不是 token，是调用。模型是无状态函数，agent 的连续性来自外部化的求值历史，不来自内部记忆。
- **政策决定成长**：`ProjectionPolicy` 决定单次求值把哪些历史引入上下文；`AdoptionPolicy` 决定求值结果是否、如何被采纳为树的节点。不可公理化的东西被政策挡在系统外部。
- **内容寻址**：节点身份 = 内容哈希。相同内容收敛为相同节点；引用即快照；结构共享。
- **执行与语义分离**：Emission/Outcome（发生了什么）先落账本，Node（是什么语义）只保存政策认定的语义块——来源与语义不互相污染。
- **命令账本**：SQLite 只存"发生了什么"（append-only 命令序列）；树的当前状态是账本重放的产物。账本线性、树分叉、CAS 裁判、崩溃后幂等重放。

## 当前状态（0.3.0）

- ✅ 公理语义核心（`src/axiomatic-v2.ts`）：Root / Node / 树 / Projection / Emission / Adoption / Evaluation
- ✅ 确定性离线内存运行时（`src/in-memory-agent-runtime.ts`）
- ✅ **任意政策插件 + 沙箱**（`src/policy-sandbox.ts`）：ESM-only、哈希钉扎、子进程隔离、无网络/无文件、超时可终止
- ✅ **SQLite 命令账本**（`src/axiomatic-durable-engine.ts` + `schema/003-axiomatic-v2.sql`）：append-only 命令、事务原子性、投影表、重放校验、崩溃恢复
- ✅ **真实模型 transport**（`src/opencode-go-client.ts`）：OpenAI-compatible、`OPENCODE_GO` 密钥、live E2E 已通过
- ✅ 生产运行时（`src/sqlite-agent-runtime.ts`）：`SqliteAgentRuntime` 组合根，evaluate/status/close/crashClose
- ✅ 崩溃恢复证明：attempt / Emission / Outcome 三切点 OS-kill 测试 + 多进程 CAS 竞争测试
- ✅ 跨 OS 字节一致 CI（Windows x64 + Linux amd64）

## 使用

```bash
npm install
npm test                 # unit + multiprocess + crash
npm run test:live:opencode-go   # 真实模型（需要 OPENCODE_GO 环境变量）
npm run release:check    # typecheck + test + build + package check
```

要求 Node.js >= 22.23.0。运行时零依赖；开发依赖仅 TypeScript / esbuild / dts-bundle-generator。

## 公开 API（0.3.0）

```ts
import { InMemoryAgentRuntime, SqliteAgentRuntime, OpenCodeGoClient } from "inductio";

// 纯内存（离线、确定性）
const memory = createInMemoryAgentRuntime({ rootPrompt: "...", evaluator: { version: "offline-evaluator/v1", kind: "echo" } });

// 持久化 + 真实模型（命令账本）
const durable = SqliteAgentRuntime.open({ databasePath: "./agent.db", root: { ... }, model: "deepseek-v4-flash" });
const result = await durable.run({ input: [...], signal });
const stateRef = durable.stateRef();   // 状态指纹（内容寻址）
durable.close();
```

发布范围细节见 `RELEASE-SCOPE.md`。

## 结构

```
src/axiomatic-v2.ts                   公理语义核心（纯内存，重放执行）
src/in-memory-agent-runtime.ts        确定性离线运行时
src/policy-sandbox.ts                 政策插件沙箱（隔离执行）
src/axiomatic-durable-engine.ts       SQLite 命令账本引擎（append/replay/audit）
src/axiomatic-sqlite-connection.ts    SQLite 连接与 schema 安装
src/sqlite-agent-runtime.ts           生产运行时组合根
src/opencode-go-client.ts             OpenAI-compatible 真实 transport
src/index.ts                          生产入口（仅导出公开面）
src/canonical-v1.ts                   内容寻址 / 规范化 / 哈希（基础）
schema/003-axiomatic-v2.sql           命令账本 schema
test/unit/                            语义 + 运行时 + 沙箱 + 持久化 + transport 测试
test/multiprocess/                    多进程 CAS 竞争证据
test/crash/                           OS-kill 崩溃恢复证据
test/fixtures/policy-plugins/         沙箱插件样例（ESM）
```

## 许可证

[MIT](LICENSE)
