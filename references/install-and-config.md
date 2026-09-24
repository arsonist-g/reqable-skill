# Install and configuration

Read this when `reqable-cli` is not yet on the machine, when a call cannot reach Reqable, or when you need to know how traffic is meant to enter Reqable in the first place. On a normal call you do not need this file.

## Prerequisites

| Requirement | Detail |
|---|---|
| Reqable desktop | Installed and running on the machine, or on the host named by `--api-host`. The CLI talks to the Reqable application process, so the process is the service. |
| A Reqable edition that can capture | Capture is the free feature; the API the CLI uses is part of it. |
| Node.js | Version 18 or newer, to run the CLI. |
| The Reqable CA certificate | Needed only for `https` bodies. Install it in the client's trust store, and turn SSL proxying on in Reqable, or `https` records will show the encrypted tunnel instead of readable bodies. |

Python scripting inside Reqable is unrelated to this CLI. Rule scripts are Reqable's own feature and run inside the application.

Creating or deleting an interception rule needs a signed-in Reqable account. On an install without one, `rule set --file` and `rule set --json` answer "requires an account" and exit 4, while `rule list`, the feature switches, and toggling a rule that already exists keep working. Treat that as a licence boundary rather than a fault.

## Install

From the directory that holds the package:

```sh
npm link          # makes reqable-cli available on PATH
reqable-cli --version
```

`npm install -g .` in the same directory installs it globally instead. The CLI has no runtime dependencies, so either form works without a network fetch.

## Health check

Run this first whenever any other command fails. It always exits 0, so read the fields rather than the exit code.

```sh
reqable-cli status
```

| Field | Meaning |
|---|---|
| `data.reachable` | `true` when Reqable answered. `false` means Reqable is not running, or `--api-port` points somewhere else. |
| `data.host`, `data.port`, `data.portSource` | Where the API was actually reached. `portSource` is `reqable-config` when the port came from Reqable's own configuration, `flag` when `--api-port` supplied it, and `default` when neither was available. |
| `data.configPath` | The Reqable configuration file the port was read from. Useful when talking to a second Reqable instance. |
| `data.capture.status` | `active` or `inactive`. Record nothing until this is `active`. |
| `data.switches` | Which capture features are on: `sslProxying`, `accessControl`, `networkThrottling`, `secondaryProxy`. Each has `active` and the profile Reqable returned. |
| `data.certificate` | Where Reqable keeps its CA material, whether the authority certificate is readable, its subject, its validity window and whether it has expired. |
| `data.errors`, `data.hint` | Why a probe failed, and what to do about it. |

## Configuration keys

There is no configuration file for the CLI. Every setting is a flag, and the two that change where it connects are global.

| Key | Default | Meaning |
|---|---|---|
| `--api-host <host>` | `127.0.0.1` | The host the Reqable API and capture proxy are reached at. Change it only for a Reqable running on another machine. |
| `--api-port <port>` | Reqable's configured proxy port, else `9000` | The port. The API and the capture proxy share it, so this is also the proxy port to point clients at. |

## Getting traffic into Reqable

A record exists only because a client sent a request to Reqable's proxy. The CLI never redirects traffic; pick one of these:

| Situation | What to configure |
|---|---|
| A program you start yourself | Set `HTTP_PROXY` and `HTTPS_PROXY` in that process's environment to `http://<api-host>:<api-port>`. This affects only that process. |
| A tool that does not trust the system CA | Use Reqable's own Proxy Terminal, which prepares the environment for it. Start it from the Reqable application. |
| An application with a proxy setting of its own | Point that setting at `<api-host>:<api-port>`. |
| A device on the network | Point the device's proxy at this machine's address and the same port, and install the CA on the device for `https`. |
| Everything on the machine | Turn the system proxy on in Reqable itself. This is a machine-wide change, so prefer a per-process proxy whenever it is enough. |

Two consequences worth knowing before you conclude that capture is broken:

- A client that ignores proxy settings, such as one with its own connection pool or a hardcoded direct route, produces no record. Nothing in the filters can reveal it.
- Requests addressed to the same machine still go through the proxy when the client is told to use it. A local test server is a valid capture target.

## Verifying the whole path

```sh
reqable-cli capture on
reqable-cli capture clear --yes
# route one client through the proxy and let it make a request
reqable-cli capture list --limit 5
```

A non-empty `data.items` means the API, the capture engine and the client's proxy route are all working. An empty list with `data.hint` naming capture as inactive means the request never reached Reqable, not that the CLI failed.
