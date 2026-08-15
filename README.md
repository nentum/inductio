# Inductio

> **引导进入。** 拉丁语 `inducere`（引导进入）的名词形式——投影政策把历史**引入**求值上下文，采纳政策把结果**引入**语义树。

Inductio 是 agent 语义的公理化核心：**agent 不是一个人，没有记忆；agent 是一个根节点加上挂在根上的求值历史树。**

## 核心理念

- **agent = 根 + 树**：agent 是根相同的所有节点的并集。树的生长 = 不断 append 求值结果，不是设计预演。
- **单次求值 = 一次完整的求值调用**：模型是无状态函数，agent 的连续性来自外部化的求值历史，不来自内部记忆。
- **内容寻址**：`node := hash(parent, block)`——相同内容收敛为相同节点；引用即快照；结构共享。
- **执行与语义分离**：Emission/Outcome（发生了什么）先落账本，Node（是什么语义）只保存政策认定的语义块。
- **命令账本**：SQLite 只存"发生了什么"（append-only 命令，event sourcing）；状态 = 重放。账本线性、树分叉、CAS 裁判、崩溃后幂等重放。

## 当前状态（0.4.0）

- ✅ 公理语义核心：Root / Node / 树 / Projection / Emission / Adoption / Evaluation
- ✅ 离线内存运行时 + 政策插件沙箱（ESM-only、SHA-pinned、子进程隔离）
- ✅ SQLite 命令账本：append-only、事务原子性、投影审计、崩溃恢复（OS-kill 三切点证明）
- ✅ **多 provider transport**：统一 `ModelAdapter` 契约 + 三个内置适配器：
  `openai-chat-completions/v1`、`openai-responses/v1`、`anthropic-messages/v1`
- ✅ 账本版本化：`model-endpoint/v2` / `axiomatic-model-request/v2`，v1 格式保留兼容
- ✅ 跨 OS 字节一致 CI + conformance suite（preflight/secret/错误分类/crash cut/no-retry）

## 使用

```bash
npm install
npm test                  # unit + multiprocess + crash
npm run test:live:models  # 真实模型（需要对应 API 密钥环境变量）
npm run release:check     # typecheck + test + build + package check
```

要求 Node.js >= 22.23.0。运行时零依赖。

## 公开 API（0.4.0）

```ts
import { InMemoryAgentRuntime, SqliteAgentRuntime, executePolicyPlugin } from "inductio";

// 离线（确定性）
const memory = createInMemoryAgentRuntime({ rootPrompt: "...", evaluator: { version: "offline-evaluator/v1", kind: "echo" } });

// 生产（命令账本 + 真实模型，多 provider）
const durable = SqliteAgentRuntime.open("./agent.db", { rootPrompt: "...", toolDefinitions: [] }, {
  provider: "anthropic",            // 或 "openai" / "opencode-go"
  adapter: "anthropic-messages/v1", // 或 openai-chat-completions/v1 / openai-responses/v1
  model: "claude-...",
  apiKeyEnv: "ANTHROPIC_API_KEY",   // 密钥只在 dispatch 时读取，不进账本
});
const result = await durable.run({ input: [...], signal });
durable.close();
```

## 分层

```
src/axiomatic-v2.ts                   公理语义核心（纯内存，重放执行）
src/in-memory-agent-runtime.ts        确定性离线运行时
src/policy-sandbox.ts                 政策插件沙箱
src/axiomatic-durable-engine.ts       SQLite 命令账本引擎（append/replay/audit/CAS）
src/axiomatic-sqlite-connection.ts    SQLite 连接与 schema 安装
src/model-adapter.ts                  统一 ModelAdapter 契约（preflight/dispatch/classify）
src/model-adapters.ts                 三个内置适配器（chat-completions/responses/messages）
src/model-contract.ts                 endpoint/request v2 契约（账本版本化）
src/sqlite-agent-runtime.ts           生产运行时组合根
src/index.ts                          生产入口（仅导出公开面）
schema/003-axiomatic-v2.sql           命令账本 schema
test/unit|multiprocess|crash|live     语义/并发/崩溃恢复/真实模型验证
```

## 扩展点（想象力所在）

- **投影政策**（沙箱）：`{root,parent,path,candidateInput,env,endpoint} → {selectedNodes, appendContent}`
- **采纳政策**（沙箱）：`{evaluation,emissions,outcome,projection} → adopt{block} | reject{reason}`
- **适配器**（内部注册）：`preflight → PreparedCall; dispatch(signal) → Completion; classify(err)`
- **世界入口**：`run({input, environment})`——模型输出只经采纳政策进树

## 硬边界

- 政策无权力：DTO-only、沙箱（无 import/fs/net/clock、同步、超时、内存限额）
- 账本只追加：无 update/delete；重放结果必须与记录结果一致（防篡改）
- tool_calls 是语义文本，从不执行；无能力/副作用
- 一个 SQLite 文件 = 一个 agent；N 个 agent = N 个文件（产品面 Map + 懒加载）
- 密钥只在 dispatch 读取（环境变量），永不进账本/快照/错误

## 许可证

[MIT](LICENSE)
