# Inductio

Inductio 是一个typescript库，服务基于 LLM 的 agent 系统。但它并非试图提供更好的agent框架，而是尝试提供一个更好的地基，从而提升agent框架的上限。

## 核心理念

- 目前来说，大模型与人类的智能形态差异较大，因此inductio希望尽可能地从机械的视角看待大模型。例如，Inductio将大模型的`最小工作单位`定位为一次api调用，而非一次prompt。

- `agent个体`的定义锚定在一个不可变的`内容节点`；最终引用这一不可变内容节点的所有内容节点构成一个agent个体。也就是说，它原生并强烈支持fork。

- `账本`系统，一切可审计。

- `内容寻址`驱动。

- 细粒度`事件追踪`，崩溃后可沿账本重放还原状态。

- `引用`动作被定义为提取当前快照，不干扰系统正常运行。

- `乐观锁`当裁判，基于过期版本的写入会被拒绝

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
import { createInMemoryAgentRuntime, SqliteAgentRuntime } from "inductio";

// 离线（确定性，不接真实模型）
const memory = createInMemoryAgentRuntime({
  rootPrompt: "...",
  evaluator: { version: "offline-evaluator/v1", kind: "echo" },
});

// 生产（命令账本 + 真实模型，多 provider）
const durable = SqliteAgentRuntime.open("./agent.db", { rootPrompt: "...", toolDefinitions: [] }, {
  provider: "anthropic",            // openai / opencode-go / anthropic
  adapter: "anthropic-messages/v1", // 或 openai-chat-completions/v1 / openai-responses/v1
  model: "claude-...",
  // 密钥从固定环境变量读取（anthropic→ANTHROPIC_API_KEY，openai→OPENAI_API_KEY，
  // opencode-go→OPENCODE_GO），只在请求发出时读取，不进账本、不落盘
});

const result = await durable.run({
  parent: durable.root().ref,       // 从根开始第一次求值
  source: "demo",                  // 输入来源标识
  position: { seq: 1 },             // 来源位置（内容寻址，重复位置同输入幂等）
  input: [{ kind: "message", role: "user", content: "你好" }],
  signal,                           // 可选的 AbortSignal
});

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

## 致歉

由于本项目几乎完全由AI执行落地，内容和代码可能存在难以理解的地方（例如标识符的设置）。

敬请谅解，我会持续优化。

## 开源协议

[MIT](LICENSE)
