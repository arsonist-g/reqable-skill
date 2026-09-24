> 本文件是 `SKILL.md` 的中文译文，供人工校对使用。同目录下的英文文件 `SKILL.md` 是生效版本，两者逐句对应。英文版改动时，本文件同步改动。

---
name: reqable-cli
description: 从命令行查看抓到的 HTTP 流量、把一次抓包会话导出为 HAR、重放某条已捕获的请求，以及开关 Reqable 的断点、改写与脚本。触发场景包括：弄清某个应用向某个 API 发送了什么、按 host/方法/状态码/关键字筛选抓包结果、完整取出某条请求与响应（含 body）、导出一次会话交给别人打开、重发一条已捕获的请求、为某个 URL 新增或停用一条 Reqable 拦截规则。它驱动 `reqable-cli` 命令，该命令直接与 Reqable 自身的本地抓包 API 通信，不涉及任何 MCP 服务器。
---

# reqable-cli：处理抓到的 HTTP 流量

`reqable-cli` 是 Reqable（桌面端 HTTP 调试代理）的命令行前端。它向 Reqable 自身的本地 HTTP API 索取抓包记录，每次调用在标准输出打印一个 JSON 对象。Reqable 必须已安装且正在运行，因为该 API 由 Reqable 应用进程本身提供。安装方式、前置条件与配置项见 `references/install-and-config.md`。

## Output boundary

本 skill 只读取和搬运流量数据。它不：

- 判断某次捕获的交互是否正确、是否符合预期、是否是缺陷：数据由你解读。
- 让流量凭空出现。只有客户端在抓包开启时被路由经过 Reqable 代理，记录才会存在；本 skill 无法捕获一个从未经过代理的请求。
- 决定谁可以被拦截。某个目标是否获得授权由调用方负责，本 skill 中没有任何命令能确立授权。
- 取代 Reqable 的图形界面。CLI 未暴露的部分（会话搜索历史、超出规则端点的集合编辑、证书安装）在应用内完成。
- 注册、启动或配置 MCP 服务器。

## How to read this skill

含「必须」「不要」「判断标准是」的句子是规则。表格是参考资料：读你需要的那一行，其余跳过。代码块展示调用的形状，可以照改使用。有两个文件存放少见路径，日常调用不读：

| 文件 | 内容 |
|---|---|
| `references/install-and-config.md` | 如何把 `reqable-cli` 装到机器上、前置条件、配置项及其默认值，以及流量究竟如何进入 Reqable |
| `references/errors.md` | 完整的退出码与错误码集合、每个码对应的动作，以及哪些失败值得重试 |

调用无法连上 Reqable 时要做的健康检查，也写在 `references/install-and-config.md` 里。

## The lifecycle

任何读取流量的调用之前，必须有两样东西存在：

1. Reqable 应用正在运行，且运行在你本机或你连接的那台主机上。`reqable-cli status` 用 `data.reachable` 报告这一点。
2. 抓包正在运行。`reqable-cli capture on` 开启它；在任何记录可能存在之前，`data.capture.status` 必须为 `active`。

记录只存在内存中，且属于当前抓包会话。关闭 Reqable 或执行 `capture clear` 都会丢弃它们，记录 ID 也会重新开始。规则改动（断点、改写或脚本）会超出本次运行并持续影响流量，直到被关闭。

## The loop

```sh
reqable-cli capture on
# 让一个客户端走 Reqable 代理，然后让它发出你关心的那个请求
reqable-cli capture list --limit 20
reqable-cli capture get <id>
```

调用方最常犯的错：使用一次 `capture clear` 之前取到的 ID，或使用另一个会话的 ID。ID 会被复用，所以请从你正在看的那次列表结果中取 ID，并立即使用。

## Command usage

```sh
reqable-cli <command> [subcommand] [required positionals] [flags]

# 先看某个 host 上最新的 POST，再完整取出那条记录
reqable-cli capture list --host api.example.com --method POST --limit 5
reqable-cli capture get 42
```

- `reqable-cli capture get 42` 把 `<id>` 作为位置参数，放在子命令之后。flag 跟在它后面。
- `--help` 是签名在运行时的唯一可信来源。运行 `reqable-cli <command> --help`，不要凭记忆使用 flag 列表；每个命令与子命令都会在标准输出回答它并以 0 退出。
- 输出是标准输出上的一个 JSON 对象。成功为 `{"ok":true,"command":"...","data":{...},"meta":{...}}`；失败为 `{"ok":false,"command":"...","error":{"code":"...","message":"...","exitCode":N}}`。成功时读 `data`，失败时读 `error.code`。标准输出不会有别的内容，因此输出可以直接交给 JSON 解析器。
- 全局 flag，所有命令都接受：

| Flag | 含义 |
|---|---|
| `--api-host <host>` | Reqable API 的主机。默认 `127.0.0.1`。它指的是 API 在哪里，不是筛选对象。 |
| `--api-port <port>` | Reqable API 的端口。默认取自 Reqable 自身配置，否则为 `9000`。 |
| `--json` | 标准输出上的机器可读输出。默认开启；显式传入也无害。 |
| `--pretty` | 缩进 JSON。用于阅读，不用于解析。 |
| `--help` | 打印该命令的帮助并以 0 退出。 |

注意两个名字相近的 flag：`--api-host` 是 API 端点，而在 `capture list` 与 `capture export` 中，记录筛选用的是 `--host`。两者是不同的东西。

## Command surface

| 分组 | 命令 |
|---|---|
| 会话状态 | `status`、`capture on`、`capture off`、`capture clear` |
| 读取记录 | `capture list`、`capture get`、`capture curl`、`capture export` |
| 发送流量 | `replay` |
| 规则 | `rule list`、`rule set` |

筛选 flag 由 `capture list` 与 `capture export` 共用，下面只列一次。各命令的表格不再重复它们。

| 筛选 flag | 含义 |
|---|---|
| `--host <h>` | 精确匹配请求的 host。可重复或用逗号分隔以匹配多个。 |
| `--url <u>` | 精确匹配请求 URL。 |
| `--method <m>` | 匹配 HTTP 方法，例如 `GET` 或 `POST`。 |
| `--code <c>` | 匹配响应状态码，例如 `200` 或 `404`。 |
| `--keyword <k>` | 在 URL、header 与 body 中匹配关键字。 |
| `--regex` | 把 `--keyword` 当作正则表达式。 |
| `--case-sensitive` | 让 `--keyword` 匹配区分大小写。 |
| `--ip <ip>` | 匹配远端 IP 地址。 |
| `--app <name>` | 匹配客户端应用名的子串。 |
| `--pid <n>` | 匹配客户端应用进程号。 |

多个筛选条件之间是逻辑与。

会话状态：

| 命令 | 说明 | 参数 | 备注 |
|---|---|---|---|
| `status` | 报告 Reqable 是否可达，以及哪些抓包功能已开启。 | `--pretty` | 始终以 0 退出，包括 Reqable 未运行时：答案在 `data.reachable`，原因在 `data.errors` 与 `data.hint`。其他命令失败时从这里开始查。 |
| `capture on` | 开启抓包，使经过代理的流量被记录。 | | 它不改变路由。请自行把客户端指向代理。 |
| `capture off` | 关闭抓包。 | | 在 Reqable 仍在运行期间，已收集的记录依然可读。 |
| `capture clear` | 丢弃全部保留的记录。 | `--yes*` | 清空会话并让 ID 空间重新开始。缺少 `--yes` 时以退出码 6 拒绝。 |

读取记录：

| 命令 | 说明 | 参数 | 备注 |
|---|---|---|---|
| `capture list` | 列出抓到的请求，可选筛选。 | `--limit <n>` `--sort <newest\|oldest>` `--ids-only` | `--limit` 默认 50，`0` 表示不限制。返回的 `data.items[]` 含 `id`、`uid`、`protocol`、`url`、`host`、`path`、`method`、`statusCode`、`statusText`、`responseMime`、`requestBodyBytes`、`responseBodyBytes`、`application`、`startedAt`、`remote`。加 `--ids-only` 时只填 `data.ids`，调用代价低得多。 |
| `capture get <id>` | 取出某条记录及其完整的请求、响应与 body。 | `<id>` `--out <file>` `--body-out <file>` | `data.record` 是原始记录。`--body-out` 把响应 body 解码为原始字节写入文件。 |
| `capture curl <id>` | 生成可复现该请求的 cURL 命令。 | `<id>` | `data.curl` 是 Reqable 自己给出的文本，使用 Windows cmd 的换行续行符；`data.curlSingleLine` 是同一命令合并成的一行 POSIX 形式。 |
| `capture export` | 把记录写入 HAR 1.2 文件或原始 JSON 文件。 | `--out <file>*` `--format <har\|json>` `--limit <n>` `--sort <s>` | `--format` 默认 `har`，`--limit` 默认 50。`--out` 必填；`--out -` 把文档写到标准输出。结果报告 `data.writtenTo` 与 `data.bytes`。 |

发送流量：

| 命令 | 说明 | 参数 | 备注 |
|---|---|---|---|
| `replay <id>` | 重发一条已捕获的请求并报告响应。 | `<id>` `--via <direct\|reqable>` `--proxy <url>` `--header <h>` `--method <m>` `--url <u>` `--body <text>` `--timeout <ms>` `--max-body <bytes>` `--full` `--insecure` `--dry-run` | `--via` 默认 `direct`，直接请求源站。`--via reqable` 经 Reqable 代理发出，从而让这次重放被再次捕获；目标是 `https` 时需要 `--insecure`，因为 Reqable 用自己的证书做了中间人。`--dry-run` 只报告将要发出的请求而不发送。Host、content-length、connection、transfer-encoding 来自记录中的请求或被重建。 |

规则：

| 命令 | 说明 | 参数 | 备注 |
|---|---|---|---|
| `rule list` | 列出断点、改写与脚本。 | `--type <all\|breakpoint\|rewrite\|script>` | 默认 `all`。`data.rules` 按类型给出 Reqable 自己的规则对象，`data.counts` 给出总数。 |
| `rule set` | 启用、停用或新建一条规则，或开关整类规则功能。 | `--type <breakpoint\|rewrite\|script>*` `--feature <on\|off>` `--enable <id>` `--disable <id>` `--file <file>` `--json <json>` `--dry-run` | 每次调用只能给一个动作 flag。`--type` 必填。新建用的载荷会原样转发给 Reqable，因此其字段名是 Reqable 自己的；`rule list --type <t>` 能看到已有规则的形状。 |

参数标记：`<x>` 必填位置参数，`--flag` 可选 flag，`--flag*` 必填 flag，`a | b` 互斥选项。

`install-and-config.md` 存放安装命令、前置条件、配置项及其默认值，以及如何让客户端走 Reqable。

## Reading the world

Reqable 的数据模型有自己的标识与编码规则。解读记录之前先读这些。

| 项目 | 规则 |
|---|---|
| 记录 ID | 一个整数，仅在当前抓包会话内唯一。`capture clear` 之后会被复用。不要在 clear 前后复用同一个 ID，也不要假设更早会话的 ID 仍指向同一条请求。 |
| 记录 UID | 一个跨会话唯一的 UUID。需要持久保存引用时优先用它，并通过一次新的 `capture list` 把它解析回记录。 |
| 响应为 null | 响应尚未到达时 `data.record.response` 为 `null`，客户端中止的连接也会一直是 `null`。响应为 null 不是错误，这类记录也没有状态码。 |
| Body 载荷 | body 形如 `{ text, mime, encoding }`。`encoding` 为 `utf8`、`base64` 或 `file`。为 `file` 时，`text` 是运行 Reqable 那台机器上的路径，body 本体在磁盘上。 |
| 筛选机制 | 筛选只返回记录 ID，从不返回 body。`capture list` 会用第二次调用解析每个 ID，因此 `--ids-only` 是省代价的路径，而 `--limit` 限定了工作量。 |
| HAR 时间 | 每个计时段都是 `-1`，这是 HAR 1.2 中「不可用」的取值，因为 Reqable 不为实时记录提供分段计时。只有 `startedDateTime` 是真实的。不要用本工具产出的 HAR 计算耗时。 |
| WebSocket 记录 | `protocol` 为 `websocket`，帧在 `data.record.messages[]` 中。`response` 之类的 HTTP 字段可能不存在。 |
| 抓包范围 | 记录之所以存在，只因为某个客户端把请求发到了 Reqable 代理。忽略代理设置的应用、或绕过代理的流量，无论筛选条件怎么设都不会出现。 |

## Red lines

- 不要拦截、重放或改写你没有获得授权测试的目标的流量。这里的每条命令都作用于真实流量：`capture on` 开始记录所有经代理的交互，`replay` 与 `rule set` 会改变真实服务器看到的、或真实客户端收到的内容。
- 不要为了「随便看看」而开启整类规则功能。`rule set --type <t> --feature on` 会改变本机上所有匹配请求的拦截行为，而不只影响你正在分析的那部分流量。
- 不要通过修改系统代理设置来引导流量。本 CLI 从不这样做，这里也不需要。请用 `HTTP_PROXY` 或应用自身的代理设置把客户端指向代理。
- 不要不做检查就重放。先跑 `replay <id> --dry-run`，再发送。重放会重复原请求所造成的一切副作用。
- 不要在别人正在读取会话时用 `capture clear` 来「清理」。它会摧毁其他人依赖的 ID 空间。
- 不要把某次抓包说成完整的。它永远只包含抓包开启期间经过代理的那部分流量。

## Errors

按退出码分支，不要按消息文本分支。最常遇到的码：

| 退出码 | `error.code` | 动作 |
|---|---|---|
| 0 | （无） | 成功。读 `data`。 |
| 2 | `USAGE` | 调用本身有错：未知 flag、缺少位置参数、或 `--json` 的 JSON 不合法。修正命令；读 `reqable-cli <command> --help`。 |
| 3 | `REQABLE_UNREACHABLE` | Reqable 未运行，或 API 端口不对。启动 Reqable，然后运行 `reqable-cli status`。 |
| 4 | `REQABLE_API_ERROR` | Reqable 返回了错误，例如它拒绝了某个筛选载荷。读 `error.details.message`。 |
| 5 | `NOT_FOUND` | 没有该记录，或文件不存在。重新列出记录并取新的 ID。 |
| 6 | `CONFIRMATION_REQUIRED` | `capture clear` 需要 `--yes`。只在确实要丢弃会话时带上它重跑。 |

全部错误码、全部退出状态，以及哪些失败值得重试，见 `references/errors.md`。
