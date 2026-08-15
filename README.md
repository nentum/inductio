# Inductio

Inductio 是一个 TypeScript 库，服务于基于 LLM 的 agent 系统。但它并非试图提供一个更好的 agent 框架，而是尝试提供一个更好的地基，从而提升 agent 框架的上限。

它不关心工作流的画法，而关心一个 agent，它如何拥有稳定的身份、可追溯的历史，以及在进程崩溃后仍然说得清“发生过什么”。

## 核心理念

- 目前来说，大模型与人类的智能形态差异较大，因此 Inductio 希望尽可能从机械的视角看待大模型。例如，Inductio 将一次完整的模型求值作为最小工作单位，而不是把一段 prompt 当作 agent 本身。

- agent 个体锚定在一个不可变的 Root。所有从该 Root 沿单一 parent 链合法生长出的内容节点，共同构成一个 agent。也就是说，它原生并强烈支持 branch。

- 账本系统。关键执行过程先记录，再推进状态，尽可能做到一切有据可查。

- 内容寻址驱动。内容决定引用，而不是由运行时随机分配身份。

- 细粒度事件追踪。进程崩溃后，可以沿账本重放并恢复已经确定的状态；无法确定的外部调用会被标记为 unknown，而不是偷偷重试。

- 引用是只读的。读取内容引用、状态指纹或快照不会干扰系统继续运行。

- 乐观锁（CAS）当裁判。基于过期版本的并发写入会被拒绝，而不是互相覆盖。

- 模型输出不会自动成为 agent 的一部分。它必须先成为可审计的 Emission，再经过明确的采纳决定，才可能形成新的内容节点。

## 目前提供什么

- 确定性的离线内存运行时；
- 可序列化、可校验的运行时快照；
- 受限的政策插件执行路径；
- 基于 SQLite 的 append-only 命令账本；
- 崩溃恢复、重放校验与并发 CAS；
- OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三种原生模型适配器；
- OpenCode Go 作为 OpenAI Chat Completions 的一个 endpoint profile；
- 零 npm 运行时依赖。

当前版本只支持 Node.js `>=22.23.0`，以及 Windows/Linux x64。浏览器、macOS 和 ARM 尚未验证或支持。Inductio 仍处于 `0.x` 早期阶段，升级前请先阅读 release scope 并验证已有账本。

## 安装

Inductio 目前还没有执行 npm publish。可以先从源码构建：

```bash
git clone https://github.com/nentum/inductio.git
cd inductio
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

也可以生成本地 tarball，再安装到另一个项目：

```bash
npm run package:check
npm install /absolute/path/to/inductio/release/inductio-0.4.0.tgz
```

## 快速开始

### 离线运行

离线路径不访问真实模型，适合测试语义、分支和重放：

```ts
import { createInMemoryAgentRuntime } from "inductio";

const runtime = createInMemoryAgentRuntime({
  rootPrompt: "你是一个简洁的助手。",
  toolDefinitions: [],
});

const result = runtime.run({
  parent: runtime.root().root,
  source: "example",
  position: { sequence: 1 },
  input: [{ kind: "message", role: "user", content: "你好" }],
  evaluator: { version: "offline-evaluator/v1", kind: "echo" },
});

console.log(result.status, result.head);
```

### SQLite 与真实模型

SQLite 路径必须是本机绝对路径。一次 Attempt 最多只会发送一次 provider 请求；Inductio 不会自动重试或透明切换 provider。

```ts
import { resolve } from "node:path";
import { SqliteAgentRuntime } from "inductio";

const runtime = SqliteAgentRuntime.open(
  resolve("inductio-example.sqlite"),
  {
    rootPrompt: "你是一个简洁的助手。",
    toolDefinitions: [],
  },
  {
    provider: "anthropic",
    adapter: "anthropic-messages/v1",
    model: "claude-3-5-haiku-latest",
  },
);

try {
  const result = await runtime.run({
    parent: runtime.root().root,
    source: "example",
    position: { sequence: 1 },
    input: [{ kind: "message", role: "user", content: "你好" }],
  });

  console.log(result.status, result.head);
} finally {
  runtime.close();
}
```

## 模型配置

| Provider | Adapter | 密钥环境变量 |
| --- | --- | --- |
| OpenCode Go | `openai-chat-completions/v1` | `OPENCODE_GO` |
| OpenAI | `openai-chat-completions/v1` 或 `openai-responses/v1` | `OPENAI_API_KEY` |
| Anthropic | `anthropic-messages/v1` | `ANTHROPIC_API_KEY` |

密钥变量由内置 provider 固定映射，不能通过公开 API 改写。密钥只在请求前读取，不进入语义节点、请求账本、快照、状态引用、SQLite/WAL/SHM 或错误文本。

## 明确不做什么

Inductio 当前不是完整的 agent 框架，也不提供：

- 自动重试或透明 provider failover；
- tool call、能力执行或不可逆外部副作用；
- streaming resume；
- 分布式共识或多机共享账本；
- 面向恶意租户的正式安全沙箱。

政策插件使用独立子进程和 Node 权限限制，但这只是 best-effort 边界。面对不可信代码时，仍应使用经过独立审计的容器或虚拟机隔离。

## 开发

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run release:check
```

真实模型测试是独立的 opt-in 命令，不属于普通离线 gate：

```bash
npm run test:live:models
```

更多精确的支持范围和边界见 [RELEASE-SCOPE.md](RELEASE-SCOPE.md)。

## 贡献

Issue 和 Pull Request 都欢迎。提交前请先阅读 [贡献指南](https://github.com/nentum/inductio/blob/main/CONTRIBUTING.md)，并确保 `npm run release:check` 通过。

如果发现安全问题，请不要在公开 Issue 中附上利用细节，处理方式见 [安全策略](https://github.com/nentum/inductio/blob/main/SECURITY.md)。

## 致歉

由于本项目早期几乎完全由 AI 执行落地，内容和代码中可能存在难以理解的地方，例如部分标识符和历史命名。

敬请谅解。我会持续优化，也欢迎直接指出问题。

## 开源协议

[MIT](LICENSE)
