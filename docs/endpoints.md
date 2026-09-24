# Reqable local API: extracted endpoint record

Every route `reqable-cli` calls, with the source line it was extracted from, plus the routes that exist and are deliberately not called. The point of this file is that endpoint drift can be checked mechanically: re-download the source, compare hashes, and diff this table against `src/reqable.js`.

## Source

| Item | Value |
|---|---|
| Repository | `github.com/reqable/reqable-mcp-server` |
| Revision read | branch `main`, archive downloaded 2026-09-25 |
| Declared version | `1.0.2` (`pubspec.yaml`), matching the latest published npm package |
| How it was obtained | `https://ghproxy.net/https://github.com/reqable/reqable-mcp-server/archive/refs/heads/main.zip`. Direct `git clone` over `https://github.com` fails on this machine with `Recv failure: Connection was reset`; the mirror returned 200. |
| Local extraction | session scratch directory, `src/reqable-mcp-server-main` |

File hashes, so a later reader can confirm the citations still point at the same code:

| File | SHA-256 |
|---|---|
| `lib/api/client.dart` | `33b35f7722fe0458e9109875cb01e9917696b010b0a032771a3dc4a6a2325ca4` |
| `lib/config.dart` | `40b31063bc44b2b3c83869dbca1736e886d5c92b757663e82a7aaffb90b7c05c` |
| `lib/utils/storage.dart` | `e8c1a17029bb4868ee8ef5ba8506ce5a236eae70fc8a9be5135318d3563d1e55` |
| `lib/tools/capture/live.dart` | `840aec8213a40aefd2121485492ca0d0aec4db67c80d460efba6e2a5f25e5d9c` |
| `lib/tools/capture/breakpoint.dart` | `7cead44fdb57fcc15964d05144ddeb5b7ffcd5fac7ede0e7b025e188dba9db90` |
| `lib/tools/capture/rewrite.dart` | `a858c48fda8e2772c40c91a1a6bb549c02a39ecf12ad39048f237d31da5b29a3` |
| `lib/tools/capture/script.dart` | `81ddf6ce2ec3e4713ac4e061d53da9090eb3217abdfa480cd02bf0e14934d09d` |
| `lib/tools/proxy/proxy.dart` | `94cb3844689c48e09113042ce840a613d9d544ec36adf1c5a83ba722c320862b` |

Note that the upstream repository is named after its MCP server, but what it contains is a full client of Reqable's local HTTP API. `reqable-cli` reuses that client's endpoint knowledge and none of its MCP layer.

## A second way to list routes: the shipped binary

The capability families are also visible in the `mcp-server.exe` that ships inside Reqable's install directory. That is useful when a future Reqable release is not published yet, and it costs one command:

```sh
grep -aoE '/capture/[a-z-]+' "C:/Program Files/Reqable/mcp-server.exe" | sort -u
```

It returns the families: `access-control`, `breakpoint`, `gateway`, `live`, `mirror`, `network-throttling`, `report-server`, `reverse-proxy`, `rewrite`, `script`, `secondary-proxy`, `ssl-proxying`.

What it cannot do is show subpaths, and that limit produced a wrong conclusion once. Probing `/capture/ssl_proxying`, `/capture/access_control` and `/capture/secondary_proxy` returns 404, and so does the bare family name for `live` and `http`, which reads as "this feature has no API". It does have one: the real routes use hyphens rather than underscores and carry a subpath, as in `/capture/ssl-proxying/get-active` and `/capture/live/status`. Treat the binary listing as a family index, and the source extraction below as the route list.

## Authentication: there is none

`lib/api/client.dart` builds every request with a User-Agent and, for a non-empty payload, a JSON content type. It sets no authorization header, no token, no cookie, and no query signature.

| Evidence | Line |
|---|---|
| Only the User-Agent is configured on the HTTP client | `lib/api/client.dart:27` |
| The request carries the JSON body and content type, nothing else | `lib/api/client.dart:50-55` |
| Routes are used verbatim as the URL path on `host:port` | `lib/api/client.dart:46` |

Confirmed against a live instance: `curl -s http://127.0.0.1:9000/capture/live/status` returns `{"status":"inactive"}` with no credential of any kind.

## Port discovery

The port is the same port Reqable's capture proxy listens on, so the CLI never needs a second setting.

| Fact | Evidence |
|---|---|
| Default host is `127.0.0.1`, default port is `9000` | `lib/config.dart:10-11` |
| With no `--port`, the port is read from Reqable's own config file | `lib/config.dart:56-79` |
| The config path is `<storage root>/config/capture_config` | `lib/config.dart:57-60` |
| The field read is `proxyPort` | `lib/config.dart:79` |
| The storage root is `%APPDATA%\Reqable` on Windows, `~/Library/Application Support/com.reqable.macosx` on macOS, `~/.local/share/com.reqable.linux` on Linux | `lib/utils/storage.dart:6-33` |

Confirmed against a live instance: `%APPDATA%\Reqable\config\capture_config` contains `"proxyPort":9000`, and `netstat -ano` shows that port owned by the `Reqable.exe` process.

## Routes reqable-cli calls

All paths are relative to `http://<api-host>:<api-port>`. These 29 routes are the subset of the 164 distinct path literals found in the source that `reqable-cli` actually calls.

| Route | Method | Source | CLI command |
|---|---|---|---|
| `/capture/live/status` | GET | `lib/tools/capture/live.dart:290` | `status`, `capture on`, `capture off` |
| `/capture/live/on` | POST | `lib/tools/capture/live.dart:299` | `capture on` |
| `/capture/live/off` | POST | `lib/tools/capture/live.dart:300` | `capture off` |
| `/capture/live/filter` | POST | `lib/tools/capture/live.dart:308` | `capture list`, `capture export` |
| `/capture/live/get` | POST | `lib/tools/capture/live.dart:317` | `capture get`, `capture list`, `capture export`, `replay` |
| `/capture/live/clear` | POST | `lib/tools/capture/live.dart:326` | `capture clear` |
| `/capture/live/generate/curl` | POST | `lib/tools/capture/live.dart:334` | `capture curl` |
| `/capture/ssl-proxying/get-active` | GET | `lib/tools/capture/ssl_proxying.dart:262` | `status` |
| `/capture/access-control/get-active` | GET | `lib/tools/capture/access_control.dart:295` | `status` |
| `/capture/network-throttling/get-active` | GET | `lib/tools/capture/network_throttling.dart:293` | `status` |
| `/capture/secondary-proxy/get-active` | GET | `lib/tools/capture/secondary_proxy.dart:341` | `status` |
| `/capture/breakpoint/list` | GET | `lib/tools/capture/breakpoint.dart:420` | `rule list` |
| `/capture/rewrite/list` | GET | `lib/tools/capture/rewrite.dart:426` | `rule list` |
| `/capture/script/list` | GET | `lib/tools/capture/script.dart:443` | `rule list` |
| `/capture/breakpoint/on` | POST | `lib/tools/capture/breakpoint.dart:411` | `rule set --feature on` |
| `/capture/breakpoint/off` | POST | `lib/tools/capture/breakpoint.dart:412` | `rule set --feature off` |
| `/capture/rewrite/on` | POST | `lib/tools/capture/rewrite.dart:417` | `rule set --feature on` |
| `/capture/rewrite/off` | POST | `lib/tools/capture/rewrite.dart:418` | `rule set --feature off` |
| `/capture/script/on` | POST | `lib/tools/capture/script.dart:434` | `rule set --feature on` |
| `/capture/script/off` | POST | `lib/tools/capture/script.dart:435` | `rule set --feature off` |
| `/capture/breakpoint/enable` | POST | `lib/tools/capture/breakpoint.dart:429` | `rule set --enable` |
| `/capture/breakpoint/disable` | POST | `lib/tools/capture/breakpoint.dart:430` | `rule set --disable` |
| `/capture/rewrite/enable` | POST | `lib/tools/capture/rewrite.dart:435` | `rule set --enable` |
| `/capture/rewrite/disable` | POST | `lib/tools/capture/rewrite.dart:436` | `rule set --disable` |
| `/capture/script/enable` | POST | `lib/tools/capture/script.dart:452` | `rule set --enable` |
| `/capture/script/disable` | POST | `lib/tools/capture/script.dart:453` | `rule set --disable` |
| `/capture/breakpoint/create` | POST | `lib/tools/capture/breakpoint.dart:448` | `rule set --file` / `--json` |
| `/capture/rewrite/create` | POST | `lib/tools/capture/rewrite.dart:454` | `rule set --file` / `--json` |
| `/capture/script/create` | POST | `lib/tools/capture/script.dart:471` | `rule set --file` / `--json` |

## Routes that exist and are not called

These are real endpoints, present in the same source, that `reqable-cli` deliberately leaves out. Each is either outside the agent-shaped command surface or unsafe to expose.

| Route group | Source | Why it is not exposed |
|---|---|---|
| `/proxy/set` | `lib/tools/proxy/proxy.dart:62` | It turns the machine's system proxy on and off. Nothing in this CLI changes machine-wide network settings. |
| `/capture/live/compose`, `/capture/live/collection/add` | `lib/tools/capture/live.dart:343`, `:352` | They create GUI tabs and collection entries, which is authoring work rather than capture reading. |
| `/rest/http/*`, `/rest/websocket/*` | `lib/tools/rest/http.dart`, `lib/tools/rest/websocket.dart` | They drive Reqable's API client tabs. The agent-shaped equivalent is `replay`, which acts on an already captured request. |
| `/collection/*` | `lib/tools/collection/collection.dart` | Collection authoring, out of scope for traffic analysis. |
| `/environment/*` | `lib/tools/environment/environment.dart` | Environment variable management, out of scope. |
| `/capture/{mirror,gateway,reverse-proxy,report-server}/**` | the corresponding files under `lib/tools/capture/` | Long-tail capture features with multi-step configuration. They stay in the GUI. |
| `/capture/{breakpoint,rewrite,script}/{lookup,update,delete,folder/*}` | the same rule files | `rule list`, `rule set --enable|--disable`, and `rule set --file` cover the read and toggle paths. Rule deletion and folder management stay in the GUI. |

Matching the CLI against this file is a grep: every string passed to `ReqableApi.get` or `ReqableApi.post` in `src/reqable.js` must appear in the "routes reqable-cli calls" table.

## Runtime-verified behaviour

These were observed against Reqable 3.2.23 on Windows, not read out of the source, and they shape the implementation.

| Behaviour | Observation |
|---|---|
| The API is served by the application process, not by a helper | Reqable's own log records each call as `Internal Server >> <METHOD> <path>`, and the listening socket belongs to `Reqable.exe`. If the application is closed, the port is gone. |
| Errors carry `{ message, status }` | `POST /capture/live/get` with an unknown id answers `404 {"message":"Record with id 999999 not found","status":404}`; a missing id answers `400 {"message":"Record id is required","status":400}`. `lib/api/client.dart:66` reads exactly that `message` field. |
| `/capture/live/filter` returns a bare JSON array of ids | `[]` when nothing is retained, `[20,21]` after two requests. It never returns bodies. |
| `/capture/live/filter` rejects an unknown filter type | `{"filters":[{"type":"nope"}]}` answers `400 {"message":"Invalid filter payload","status":400}`. |
| `/capture/live/generate/curl` answers `text/plain`, not JSON | The body is the cURL command verbatim, with Windows `^` line continuations. A JSON parser turns it into `null`, so the CLI falls back to the raw text. The route takes `id` only; a `uid` is rejected with `400 Record id is required`. |
| A POST is more reliable when it declares a JSON content type | A bare POST with no body returned 200 without the capture engine starting in one run, and 200 with the engine starting in another. A POST with `content-type: application/json` and a `{}` body started it every time. `reqable-cli` always sends the JSON form. |
| The API port and the capture proxy share one socket, and Reqable classifies a connection when it is first used | A Node client that had already used a keep-alive socket for API calls, then sent an absolute-form proxy request on that same socket, was answered by the internal API server instead of being forwarded. The request never reached the target. A one-shot connection fixes it, and `replay --via reqable` opens one for the request. The same trap applies to the `CONNECT` a proxied `https` request needs: on a reused socket the CONNECT hangs up without a tunnel, which surfaces as `socket hang up`, so the CONNECT also opens its own connection. |
| A loopback target is forwarded normally | `curl -x http://127.0.0.1:9000 http://127.0.0.1:18080/...` reaches the local server and is captured, for `GET`, `POST` and error responses alike. |
| Creating and deleting a rule is gated behind a Reqable account | On an install with no account signed in, `POST /capture/<type>/create` and `POST /capture/<type>/delete` answer `401 {"message":"Creating <type> requires an account, please login to your Reqable account.","status":401}`. `GET /capture/<type>/list`, `POST /capture/<type>/on|off`, and `POST /capture/<type>/enable|disable` all answer 200 on the same install. |
| The rule toggle body is validated before the id is looked up | `{\"ids\":[\"any\"],\"enabled\":false}` answers 200 while `{}` answers `400 "<Type> id list is required."` and `{\"ids\":\"x\",\"enabled\":\"y\"}` answers `400 "<Type> id list must be a list of strings."`. That is how the CLI's payload shape can be proven correct without a rule to toggle. |
| An `https` target is intercepted, and its decrypted body is readable | `curl -x <proxy> https://127.0.0.1:18443/...` against a loopback TLS server with a self-signed certificate produced a record whose response body was plain JSON. Replaying that record with `replay --via reqable --insecure` reached the target and answered 200. |
| The interception certificate is not trusted by a client that has not installed the CA | The same `curl` invocation with `--cacert <Reqable CA>` failed the handshake and needed `-k`; `replay --via reqable` without `--insecure` failed with `unable to verify the first certificate`. Both are the expected consequence of Reqable presenting its own certificate. |

## The record shape

`POST /capture/live/get` answers with one record. The shape below is the output schema declared for `capture_live_get_by_id` in `lib/tools/capture/live.dart:980-1030`.

```
protocol    "http" | "websocket"
id          integer, unique inside the current capture session
uid         string, unique across sessions
url         string
connection  { id, timestamp (ISO 8601), remote: { ip, port }, local: { ip, port } }
application { name, id?, path?, pid? }
request     { method, path, protocol, headers: [{ name, value }], body, scriptLogs[] }
response    { code, status, protocol, headers, body, scriptLogs[] } | null
messages    [ { flow, timestamp, payload } ]        (websocket only)
```

A body is `{ text, mime?, encoding }` with `encoding` in `utf8`, `base64` or `file`, and `text` required (`lib/tools/capture/live.dart:718-737`). For `encoding: file`, `text` is a filesystem path and the body lives on disk, which is why the CLI's HAR export reads it rather than inlining a path.

There is no per-phase timing anywhere in the record: the only timestamp is `connection.timestamp`. HAR output therefore reports `-1` for `time` and for every timing phase, which is HAR 1.2's own value for "unavailable".
