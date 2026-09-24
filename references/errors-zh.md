> 本文件是 `references/errors.md` 的中文译文，供人工校对使用。同目录下的英文文件 `references/errors.md` 是生效版本，两者逐句对应。

# 错误与退出码

在 `reqable-cli` 以非零退出、而一行消息里还看不出该怎么做时，读本文件。调用成功时不需要它。

每种失败依然会在标准输出打印一个 JSON 对象，所以请解析它，而不是抓 stderr：

```json
{"ok":false,"command":"capture get","error":{"code":"NOT_FOUND","message":"Record with id 999999 not found","exitCode":5,"details":{"route":"/capture/live/get","status":404,"method":"POST"}},"meta":{"durationMs":7}}
```

先按 `error.code` 分支；从 shell 驱动 CLI 时再按进程退出状态分支。

## 退出码

| 退出码 | `error.code` | 含义 | 是否重试 |
|---|---|---|---|
| 0 | （无） | 成功。结果在 `data`。 | 不适用。 |
| 1 | `INTERNAL_ERROR` | CLI 自身的缺陷，或未预期的异常。`error.details.name` 给出异常类型。 | 否。带着确切调用方式上报。设置 `REQABLE_CLI_DEBUG=1` 可在 stderr 得到堆栈。 |
| 2 | `USAGE` | 在发出任何请求之前就被拒绝：未知 flag、缺少必填位置参数、值类型不对，或载荷 JSON 无法解析。 | 可以，修好命令之后。 |
| 3 | `REQABLE_UNREACHABLE` | CLI 无法连上 `--api-host`:`--api-port` 处的 Reqable。Reqable 已关闭、未安装，或监听的端口不同。 | 可以，启动 Reqable 之后。 |
| 4 | `REQABLE_API_ERROR` | Reqable 返回了非 2xx 状态。`error.details.status` 给出该状态，`error.details.message` 给出 Reqable 自己的文本。 | 视消息而定。被拒绝的筛选载荷不可重试；短暂出现的 5xx 可以。 |
| 5 | `NOT_FOUND` | Reqable 返回 404：记录、规则或资源不存在。它就是 CLI 自己的错误码，不要与 Reqable 对未知路由返回的 JSON 形状混淆。 | 可以，取新的 ID 或路径之后。 |
| 6 | `CONFIRMATION_REQUIRED` | 调用了破坏性命令但没有带确认 flag。 | 可以，在确实要丢弃数据时带确认 flag 重跑。 |

## 各错误码对应的动作

| `error.code` | 动作 |
|---|---|
| `USAGE` | 读 `reqable-cli <command> --help` 并重建命令。`details` 通常不存在，消息里会点出出错的 flag 或参数。 |
| `REQABLE_UNREACHABLE` | 运行 `reqable-cli status`。若 `data.reachable` 为 `false`，启动 Reqable。只有在你确知 Reqable 监听在其他端口时才调整 `--api-port`。见 `install-and-config.md`。 |
| `REQABLE_API_ERROR` | 读 `error.details.message`。Reqable 拒绝某个筛选，说明该筛选的取值不是它期望的形状。若返回 401 且消息里含「requires an account」，那是新建或删除规则的账号/授权限制，不是缺陷：如实上报，不要重试，也不要去找绕过它的 flag。Reqable 返回 500 时值得重试一次，然后如实上报。 |
| `NOT_FOUND` | ID 不对，或记录在列表调用与本次调用之间被清掉了。重新运行 `capture list` 并使用该结果中的 ID。 |
| `CONFIRMATION_REQUIRED` | 对 `capture clear` 而言，带 `--yes` 重跑。没有第二个命令会在这种码后面。 |
| `INTERNAL_ERROR` | 没有可重试的动作。记录下调用方式、`error.message`、`error.details.name`，以及 `REQABLE_CLI_DEBUG=1 reqable-cli ...` 的输出。 |

## 不是错误的失败形状

| 你看到的现象 | 它意味着什么 |
|---|---|
| `ok: true` 且 `data.items` 为空，并带有 `data.hint` | 没有匹配项。hint 会说明抓包当时是关闭的，还是筛选条件太窄。hint 指出抓包为 inactive，意味着流量根本没到 Reqable。 |
| `ok: true` 且 `data.items[].statusCode` 为 null | 该记录没有响应：读取时仍在进行中，或客户端中止了连接。不是失败。 |
| `ok: true` 且 `replay` 报告非 2xx 的 `response.statusCode` | 重放本身成功了，目标返回了那个状态。目标返回 4xx 或 5xx 是结果，不是 CLI 错误；只有传输层失败才会抛 `REQABLE_API_ERROR`。 |
| `capture curl` 给出的 curl 命令在本地执行失败 | `data.curl` 使用 Windows cmd 的续行符。在 POSIX shell 上改用 `data.curlSingleLine`。 |

## 超时

请求超时与退出码是两件事：超过超时的调用会报退出码 4 并在消息中点出超时，因为失败的是传输层，而不是 Reqable 给了答复。目标是慢速时，为 `replay` 提高 `--timeout <ms>`。没有全局超时 flag；API 调用使用自己固定的、足够宽裕的预算。
