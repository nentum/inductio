# Inductio:追加式账本解释器

一个跑在本机的**追加式账本解释器**。所有内容——函数代码、调用请求、认领记录、输出、事件——都以追加方式写入一个 SQLite 账本;解释器持续扫描账本中的请求条目,把匹配的函数代码作为 Python 子进程执行,并把子进程 stdout 的 JSON 帧校验后追加回账本。

解释器自身不做任何业务;所有业务逻辑都是账本里的普通函数代码。

## 核心设计

- **账本是唯一事实源**。函数代码不按文件加载,而是作为账本条目存储;调用什么函数、用什么输入,由请求条目中的 SQL 从账本中精确选出。
- **只追加**。`UPDATE`/`DELETE` 被 SQLite 触发器直接拒绝,历史不可改写;封口(`end`)之后实例不再有输出。退出码、进程崩溃都只是"观察",不推断业务成败。
- **单写者**。同一时刻只有一个解释器进程可写账本(OS 文件锁);一切写入经由单线程调度器,每条记录有确定的先后。
- **外部内容必须经过真实入口**。外部程序只能通过入口函数进程的回环 TCP 端口提交内容,入口把它作为自己的普通 stdout 输出交给解释器入账;没有离线直写账本的退路。
- **没有隐藏的自动化**。解释器只做"发现请求 → 调度执行";不存在默认的 agent 循环,后继调用必须来自明确的请求记录。

## 快速开始

要求 Python ≥ 3.12,无第三方依赖。

```bash
python -m deductio init my.db     # 建立新账本(schema 2):创世元数据 + 入口函数 + builtin:stop
python -m deductio run my.db      # 启动解释器:发启动根请求,拉起入口,持续调度
```

另一个终端向运行中的系统提交内容:

```bash
python -m deductio entry-status my.db   # 真实探活入口(会留一条探测输出)
python -m deductio append my.db examples/seed.json   # 经入口 TCP 提交函数/材料/请求
python -m deductio show my.db           # 只读查看账本
```

`append` 也可用 `-` 从 stdin 读入。账本未运行、入口已关闭时,`append` 明确失败。

## 账本条目

单一 `entries` 表,六种条目类型:`function` / `request` / `claim` / `output` / `end` / `event`。
每行含:`id`(账本局部正整数)、`kind`、`data`(JSON 载荷)、`claim_id` + `position`(输出来源实例及序号)、`writer`(写入会话)、`created_at`。

函数子进程协议:stdin 一次性收到 JSON 调用信封(协议 `deductio.v2`,含 `protocol`/`function`/`claim`/`inputs`/`snapshot`/`ledger_uri`),读完即 EOF;stdout 逐行输出 JSON 帧(`output` / `request` / `function` / `end`),每帧上限 1 MiB。函数对账本只有只读 SQL 权限。

## 命令一览

| 命令 | 作用 |
|---|---|
| `init` | 创建新账本(创世事务,不运行函数) |
| `run` | 启动解释器(`--until-idle` 排空退出;`--max-running` 普通并发上限,默认 8) |
| `append` | 经入口 TCP 提交条目 |
| `show` | 只读查看账本(`--after` / `--limit`) |
| `entry-status` | 真实探活入口(握手 + 探测输出入账确认) |
| `close-entry` | 请求入口自行交出 end 并封口 |
| `demo` | 在新账本上运行一次完整的父子函数演示 |

## 测试

```bash
python -W error::ResourceWarning -m pytest -q -W error::pytest.PytestUnraisableExceptionWarning --tb=short
python -m compileall -q deductio tests
```

## 边界

可信本机使用:没有恶意代码沙箱、跨用户鉴权或完整进程树隔离;身份握手防止误连旧实例,不是秘密令牌认证。账本 schema 1 与 2 不兼容,旧账本只能 `show` 只读查看,不原地迁移。
