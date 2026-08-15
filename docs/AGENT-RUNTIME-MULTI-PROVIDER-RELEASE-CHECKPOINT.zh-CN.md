# Agent Runtime 0.4.0 Multi-Provider Release Checkpoint

> **当前裁决**：`axiomatic-agent-runtime@0.4.0` 的 provider-neutral durable profile
> 已通过 Windows x64 与 Linux amd64 clean-candidate source/package gate、跨 OS 构件
> byte identity 和本 checkpoint 所列 conformance；公开发布仍为 **CONDITIONAL**，因为
> license、npm authentication 与 owner 的远程/registry 授权尚未提供。
>
> **历史边界**：本文件不改写 0.1.0 offline、0.2.0 policy sandbox 或 0.3.0
> OpenCode Go checkpoint；它只记录 0.4.0 的三种 native model adapter 扩展。

## 1. 发布对象

```text
name                  axiomatic-agent-runtime
version               0.4.0
runtime dependencies  0
license               UNLICENSED
os                    win32, linux
cpu                   x64
node                  >=22.23.0
adapters               openai-chat-completions/v1
                       openai-responses/v1
                       anthropic-messages/v1
```

OpenCode Go 是 `openai-chat-completions/v1` 的 endpoint profile，不是 durable
runtime 的架构依赖。新 evaluation 使用 `model-endpoint/v2` 和
`axiomatic-model-request/v2`；历史 `axiomatic-provider-request/v1` 只保留重放兼容。

## 2. 权威与密钥边界

公开 durable 路径保持：

```text
SqliteAgentRuntime
-> AxiomaticDurableEngine (internal)
-> AxiomaticSqliteConnection (internal)
-> schema/003-axiomatic-v2.sql
-> closed native adapter selected by persisted ModelEndpointV2
```

caller 只能声明 `provider`、`adapter`、`baseUrl`、`model`、有限 timeout/token 和
`userAgent`；不能注入 model client、`fetch`、credential resolver、retry/failover
policy、SQLite handle、owner/permit 或 capability implementation。

credential 在 preflight/dispatch 时从内部固定变量读取：

```text
opencode-go  OPENCODE_GO
openai       OPENAI_API_KEY
anthropic    ANTHROPIC_API_KEY
```

变量名不进入 public declarations；值不得进入 request、command journal、stateRef、
snapshot、SQLite 主文件/WAL/SHM、日志或错误文本。

## 3. Durable 顺序与失败分类

```text
durable request -> Attempt -> Emission -> Outcome -> Adoption
```

- request/credential/configuration failure：Attempt 前 local failure 或直接 preflight 拒绝；
- HTTP/protocol/tool-call/response-limit：failed Outcome + Reject；
- network/timeout/AbortSignal/uncertain transport：Unknown；
- attempted without Outcome on restart：Unknown；
- terminal Outcome without Adoption：确定性恢复 Adoption；
- 任何路径都不自动 retry、恢复 dispatch 权或透明切换 provider。

## 4. 验证矩阵

最终 checkpoint 必须记录：

```text
Windows x64 release:check             PASS (Node 22.23.1 / npm 10.9.8)
Linux amd64 clean-candidate gate      PASS (Node 22.23.0 / npm 10.9.8 / bookworm)
detached committed-snapshot gate      PASS (npm ci + full release:check)
same-host repeated pack identity      PASS
historical artifact preservation      PASS (0.1.0 / 0.3.0 hashes unchanged)
Windows/Linux tarball byte identity   PASS
package bytes                         46,186
package SHA-256                       df9fbd68109562305201dd401fada898e75bc4b9aaeb53e0cf29bc1c85039226
package npm shasum                    e1f07dbd9a65aa29c8be431a070f0e6a5b4d9610
ARM                                   NOT RUN
```

普通 gate 保持离线。`npm run test:live:models` 是独立 opt-in probe；缺少相应
credential 时 skip，不属于 release verdict，也不得自动 retry。以上 gate 的 Windows/Linux
unit `212/212`、differential `12/12`、multiprocess `9/9`、crash `34/34`、
package/install/type smoke 均通过；live provider probe 未因构件 gate 而自动执行。

## 5. 非扩张声明

0.4.0 不提供 capability execution、不可逆 effect、stream resume、自动 retry、
transparent provider failover、distributed ownership、general environment dispatch CAS、
formal hostile-code sandbox、ARM 或 npm publication。许可证选择、npm authentication、
push/tag/publish 仍需 owner 明确授权。
