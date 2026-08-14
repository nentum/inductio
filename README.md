# Inductio

> **引导进入。** 拉丁语 `inducere`（引导进入）的名词形式——投影政策把历史**引入**求值上下文，采纳政策把结果**引入**语义树。

Inductio 是 agent 语义的公理化核心：**agent 不是一个人，没有记忆；agent 是一个根节点加上挂在根上的求值历史树。**

## 核心理念

- **agent = 根 + 树**：根是引用为 null 的节点；agent 是根相同的所有节点的并集。树的生长 = 不断 append 求值结果，不是设计预演。
- **单次求值 = 一次完整的 API 调用**：求值单位不是 token，是调用。LLM 是无状态函数，agent 的连续性来自外部化的求值历史，不来自内部记忆。
- **政策决定成长**：`ProjectionPolicy` 决定单次求值把哪些历史引入上下文；`AdoptionPolicy` 决定求值结果是否、如何被采纳为树的节点。不可公理化的东西被政策挡在系统外部。
- **内容寻址**：节点身份 = 内容哈希。相同内容收敛为相同节点；引用即快照；结构共享。
- **执行与语义分离**：Emission/Outcome（发生了什么）先落账本，Node（是什么语义）只保存政策认定的语义块——来源与语义不互相污染。

## 当前状态

- ✅ D1/D2 公理语义的**纯内存可执行见证**（`src/axiomatic-v2.ts`，零外部运行时依赖）
- ✅ 14 个测试覆盖：树结构、投影、采纳、重放幂等、政策无权力、来源绑定、unknown 状态
- ⏳ SQLite 持久化（未开始）
- ⏳ 生产入口 / 真实 transport（未开始）

## 使用

```bash
npm install
npm test        # 14 个公理语义测试
npm run typecheck
```

要求 Node.js >= 22.23.0（仅用内置模块，无运行时依赖）。

## 结构

```
src/axiomatic-v2.ts   公理语义核心（Root / Node / Evaluation / Projection / Emission / Adoption）
src/canonical-v1.ts   内容寻址 / 规范化 / 哈希（基础，复用自早期验证）
src/domains.ts        哈希域常量
src/errors.ts         语义错误类型
src/types.ts          类型定义
test/unit/            公理语义测试
```

## 名字

Inductio 与 deductio（演绎）同属拉丁语 `ducere`（引导）词族：演绎把结论从公理中**引导出来**，inductio 把历史**引导进入**上下文、把结果**引导进入**树——系统不是被证明出来的，是被长出来的。
