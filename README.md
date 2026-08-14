# Inductio

> **引导进入。** 拉丁语 `inducere`（引导进入）的名词形式——投影政策把历史**引入**求值上下文，采纳政策把结果**引入**语义树。

Inductio 是 agent 语义的公理化核心：**agent 不是一个人，没有记忆；agent 是一个根节点加上挂在根上的求值历史树。**

## 核心理念

- **agent = 根 + 树**：根是引用为 null 的节点；agent 是根相同的所有节点的并集。树的生长 = 不断 append 求值结果，不是设计预演。
- **单次求值 = 一次完整的求值调用**：求值单位不是 token，是调用。模型是无状态函数，agent 的连续性来自外部化的求值历史，不来自内部记忆。
- **政策决定成长**：`ProjectionPolicy` 决定单次求值把哪些历史引入上下文；`AdoptionPolicy` 决定求值结果是否、如何被采纳为树的节点。不可公理化的东西被政策挡在系统外部。
- **内容寻址**：节点身份 = 内容哈希。相同内容收敛为相同节点；引用即快照；结构共享。
- **执行与语义分离**：Emission/Outcome（发生了什么）先落账本，Node（是什么语义）只保存政策认定的语义块——来源与语义不互相污染。

## 当前状态（0.1.0）

- ✅ 公理语义核心（`src/axiomatic-v2.ts`）：Root / Node / 树 / Projection / Emission / Adoption / Evaluation
- ✅ **确定性离线内存运行时**（`src/in-memory-agent-runtime.ts`）：`InMemoryAgentRuntime` 生产入口，内置 echo/constant/failure 求值器，可序列化/恢复运行时快照，运行日志可重放验证
- ✅ 公开 API 面（`src/index.ts`）+ 打包产物（esbuild + dts-bundle）
- ✅ 14 + 7 个测试（公理语义 + 公开运行时），跨 OS 字节一致 CI
- ⏳ SQLite 持久化（未开始）
- ⏳ 真实模型 transport（未开始）

## 使用

```bash
npm install
npm test                # 公理语义 + 公开运行时测试
npm run release:check   # typecheck + test + build + package check
```

要求 Node.js >= 22.23.0。运行时零依赖；开发依赖仅 TypeScript / esbuild / dts-bundle-generator。

## 公开 API（0.1.0）

```ts
import { InMemoryAgentRuntime, createInMemoryAgentRuntime } from "inductio";

const runtime = createInMemoryAgentRuntime({
  rootPrompt: "...",
  toolDefinitions: [],
  evaluator: { version: "offline-evaluator/v1", kind: "echo" },
});

const result = runtime.runEvaluation({ input: "..." });
const snapshot = runtime.serializeState();   // 可持久化/恢复
```

发布范围细节见 `RELEASE-SCOPE.md`。0.1.0 刻意只支持：单进程内存运行、确定性离线求值器、完整路径内置投影、完成的输出采纳——不做并发存储、不做真实网络、不做任意策略回调。

## 结构

```
src/axiomatic-v2.ts           公理语义核心（Root / Node / Evaluation / Projection / Emission / Adoption）
src/in-memory-agent-runtime.ts 确定性离线内存运行时（公开 API 实现）
src/index.ts                  生产入口（仅导出公开面）
src/canonical-v1.ts           内容寻址 / 规范化 / 哈希（基础）
src/domains.ts                哈希域常量
src/errors.ts                 语义错误类型
src/types.ts                  类型定义
test/unit/                    公理语义 + 公开运行时测试
test/vectors/                 公开行为固定向量
scripts/                      打包与发布校验
```

## 名字

Inductio 与 deductio（演绎）同属拉丁语 `ducere`（引导）词族：演绎把结论从公理中**引导出来**，inductio 把历史**引导进入**上下文、把结果**引导进入**树——系统不是被证明出来的，是被长出来的。
