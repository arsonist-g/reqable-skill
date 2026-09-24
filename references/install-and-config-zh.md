> 本文件是 `references/install-and-config.md` 的中文译文，供人工校对使用。同目录下的英文文件 `references/install-and-config.md` 是生效版本，两者逐句对应。

# 安装与配置

在 `reqable-cli` 尚未装到机器上时、某次调用连不上 Reqable 时，或你需要知道流量究竟该如何进入 Reqable 时，读本文件。日常调用不需要它。

## 前置条件

| 要求 | 说明 |
|---|---|
| Reqable 桌面端 | 已安装并正在运行，运行在本机或 `--api-host` 指定的主机上。CLI 与 Reqable 应用进程通信，所以那个进程就是服务本身。 |
| 能抓包的 Reqable 版本 | 抓包是免费功能；CLI 使用的 API 也属于它。 |
| Node.js | 18 或更高版本，用于运行 CLI。 |
| Reqable 的 CA 证书 | 只有 `https` body 需要它。把证书装入客户端的信任库，并在 Reqable 中开启 SSL 代理；否则 `https` 记录只会显示加密隧道，而不是可读的 body。 |

Reqable 内部的 Python 脚本功能与本 CLI 无关。规则脚本是 Reqable 自身的能力，在应用内运行。

## 安装

在存放该包的目录中：

```sh
npm link          # 让 reqable-cli 进入 PATH
reqable-cli --version
```

在同一目录执行 `npm install -g .` 则改为全局安装。CLI 没有运行时依赖，两种方式都不需要联网拉取。

## 健康检查

任何其他命令失败时，先运行这一条。它始终以 0 退出，所以要读字段而不是退出码。

```sh
reqable-cli status
```

| 字段 | 含义 |
|---|---|
| `data.reachable` | Reqable 有响应时为 `true`。为 `false` 意味着 Reqable 未运行，或 `--api-port` 指向了别处。 |
| `data.host`、`data.port`、`data.portSource` | 实际连上的位置。`portSource` 为 `reqable-config` 表示端口来自 Reqable 自身配置，为 `flag` 表示由 `--api-port` 提供，为 `default` 表示两者都没有。 |
| `data.configPath` | 读取端口所用的 Reqable 配置文件。面对第二个 Reqable 实例时有用。 |
| `data.capture.status` | `active` 或 `inactive`。在它为 `active` 之前不要期待任何记录。 |
| `data.switches` | 哪些抓包功能已开启：`sslProxying`、`accessControl`、`networkThrottling`、`secondaryProxy`。每项含 `active` 与 Reqable 返回的 profile。 |
| `data.certificate` | Reqable 存放 CA 材料的位置、根证书是否可读、其 subject、有效期区间，以及是否已过期。 |
| `data.errors`、`data.hint` | 某次探测失败的原因，以及该怎么做。 |

## 配置项

CLI 没有配置文件。每一项设置都是 flag，其中决定连接目标的是两个全局 flag。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `--api-host <host>` | `127.0.0.1` | 访问 Reqable API 与抓包代理的主机。只有当 Reqable 跑在另一台机器上时才需要改。 |
| `--api-port <port>` | Reqable 配置的代理端口，否则 `9000` | 端口。API 与抓包代理共用它，所以这也就是要把客户端指向的代理端口。 |

## 让流量进入 Reqable

记录之所以存在，只因为某个客户端把请求发到了 Reqable 代理。CLI 从不重定向流量；请选择下面一种方式：

| 场景 | 需要配置什么 |
|---|---|
| 你自己启动的程序 | 把该进程环境中的 `HTTP_PROXY` 与 `HTTPS_PROXY` 设为 `http://<api-host>:<api-port>`。这只会影响那一个进程。 |
| 不信任系统 CA 的工具 | 使用 Reqable 自带的 Proxy Terminal，它会为该工具准备好环境。从 Reqable 应用里启动它。 |
| 自身带代理设置的应用 | 把该设置指向 `<api-host>:<api-port>`。 |
| 网络中的其他设备 | 把设备的代理指向本机地址与同一端口，并为 `https` 在该设备上安装 CA。 |
| 本机全部流量 | 在 Reqable 里打开系统代理。这是全机范围的改动，所以只要够用就优先选按进程设置代理。 |

在断定抓包坏掉之前，有两点后果值得先知道：

- 忽略代理设置的客户端（例如自带连接池或硬编码直连的）不会产生任何记录。任何筛选条件都无法揭示这一点。
- 目标是本机地址的请求，只要客户端被要求走代理，依然会经过代理。本地测试服务器是有效的抓包目标。

## 验证整条链路

```sh
reqable-cli capture on
reqable-cli capture clear --yes
# 让一个客户端走代理并发出请求
reqable-cli capture list --limit 5
```

`data.items` 非空，说明 API、抓包引擎与客户端的代理路由都正常。列表为空且 `data.hint` 指出抓包处于 inactive，意味着请求根本没到 Reqable，而不是 CLI 失败。
