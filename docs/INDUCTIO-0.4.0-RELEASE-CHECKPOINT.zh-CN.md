# Inductio 0.4.0 Release Checkpoint

> **当前裁决**：`inductio@0.4.0` 独立仓库的本地 source/package candidate 为 **PASS**。
> Windows x64、Linux amd64 clean candidate、跨 OS 构件 byte identity 和本文件所列
> 边界均已通过。Hosted CI、真实模型 probe 与 npm publication 均为 **NOT RUN**。
>
> 本文件只记录独立仓库 `inductio@0.4.0` 的实际证据，不沿用来源仓库的包名、许可证、
> 测试计数或构件 hash。

## 发布对象

```text
name                  inductio
version               0.4.0
license               MIT
runtime dependencies  0
node                  >=22.23.0
os                    win32, linux
cpu                   x64
adapters              openai-chat-completions/v1
                      openai-responses/v1
                      anthropic-messages/v1
```

## 迁移复核

已确认并修复的迁移问题：

- README 离线 evaluator、Root 字段和 SQLite 相对路径示例错误；
- CI 仍上传、比较 `inductio-0.3.0.tgz`；
- release checkpoint 仍使用来源包名、`UNLICENSED` 和来源构件 hash；
- release scope 将 policy profile 版本写错，并错误声称许可证仍待选择；
- 默认 User-Agent 与 policy child 环境仍使用来源项目名；
- 缺少独立仓库的 frozen/module-graph gate；
- 缺少 canonical/content-address 机械测试；
- 搬入了当前运行路径不可达的 owner/permit/capability/effect DTO 和旧 hash domain；
- npm metadata 缺少 repository、homepage、bugs 和常规开源协作入口；
- 本地 0.1.0 tarball 缺失；
- 原本的本地 0.3.0 tarball 是无法对应任一 0.3.0 commit 的混合构件。

0.1.0 已由 `e30ac30` 的 Git blob 快照重建；0.3.0 已由最后一个 0.3.0 快照
`43fc9b4` 重建。当前 package gate 会验证 sibling tarball 不被删除或改写。

本次没有把来源仓库的 capability、owner lease、effect、v1 SQLite migration、完整
production-hardening 或 differential harness 搬回 Inductio；它们不属于本仓库声明的范围。

## 核心边界

```text
durable request -> Attempt -> Emission -> Outcome -> Adoption
```

- request 必须在 Attempt 前持久化；
- Emission 必须在 Outcome/Adoption 前持久化；
- unknown 不恢复自动派发权；
- 不自动 retry，不透明 failover；
- 模型或政策文本不取得 capability 权力；
- secret 不进入 public declaration、语义树、账本、快照、stateRef、SQLite/WAL/SHM、日志或错误。

## 验证矩阵

```text
Windows x64 release:check             PASS (Node 22.23.1 / npm 10.9.8)
Linux amd64 clean-candidate           PASS (Node 22.23.0 / npm 10.9.8 / bookworm)
detached committed-snapshot           PASS (npm ci + full release:check)
frozen vector/schema/license          PASS
production module graph               PASS (14/14 source modules reachable)
unit                                  PASS (63/63)
multiprocess                          PASS (1/1)
crash                                 PASS (4/4)
same-host repeated pack identity      PASS
historical artifact preservation      PASS
Windows/Linux tarball byte identity   PASS
package contents/install/type smoke   PASS
package files                         7
package bytes                         48,216
package SHA-256                       15534997ad2a9525676cfbc124ced75b829dd44214fff52ff6a1836fffa2218c
package npm shasum                    dcb2bf5d1b581ed0dee836778498de1d800ea20a
hosted CI                             NOT RUN
live model adapters                   NOT RUN
npm publication                       NOT RUN
ARM                                   NOT RUN
```

本地历史构件：

```text
0.1.0 SHA-256  b404db0804c5322585260d407c41847c5aceb24c8ef0354ecaff65d2c30d589f
      shasum   42df3da809d6ce7ccc67ee5f9c82518867f6a321
0.3.0 SHA-256  f3153cd96a5796464f05ab0d5bf82bdc125a159fc9600337c4726ec4bf007597
      shasum   e00b323b41561ce2137d71371d5701cf19bfeeae
```

普通 gate 保持离线。`npm run test:live:models` 是独立 opt-in 命令，不属于 release
裁决，且不会被普通 gate 自动执行。
