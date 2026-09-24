# reqable-cli

A command-line front end for [Reqable](https://reqable.com)'s local capture API, plus a skill that teaches an AI agent to use it. It exists so an agent can read captured traffic without registering an MCP server.

## Why not the MCP server

Reqable's only official AI interface is `reqable-mcp-server`, an MCP server that exposes more than a hundred tools. Registering an MCP server injects its whole tool list into every request's system prompt, and a hundred tool names is a poor trade for what traffic analysis actually needs: see what was captured, filter it, pull one exchange out in full, export it, re-send it.

This CLI does not re-expose a hundred tools. It exposes ten entry points shaped around the tasks an agent has, and each writes one JSON object to stdout.

## Install

```sh
npm link                 # from this directory; puts reqable-cli on PATH
reqable-cli --version
reqable-cli --help
```

No runtime dependencies, so no network fetch is needed. Node.js 18 or newer.

Reqable must be installed and running: the API this CLI calls is served by the Reqable application process on the same port as its capture proxy. When Reqable is closed there is nothing to talk to, and the CLI says so instead of pretending.

## Minimal usage

```sh
reqable-cli status                    # is Reqable reachable, and is capture on
reqable-cli capture on
HTTP_PROXY=http://127.0.0.1:9000 curl https://api.example.com/things
reqable-cli capture list --host api.example.com
reqable-cli capture get 7
```

`--help` on any command is the reference: `reqable-cli capture export --help`.

## Command surface

Ten entry points. `capture` and `rule` are branches; the rest are single commands.

| Command | Purpose |
|---|---|
| `status` | Reqable reachability, API port and its source, capture state, which capture features are on, CA certificate state |
| `capture list` | List captured records, filtered and bounded |
| `capture get <id>` | One record with its full request, response and bodies |
| `capture curl <id>` | A cURL command that reproduces the request |
| `capture export` | Write records to a HAR 1.2 or raw JSON file |
| `capture clear` | Discard the session (requires `--yes`) |
| `capture on` / `capture off` | Start and stop capture |
| `replay <id>` | Re-send a captured request, directly or through Reqable |
| `rule list` | List breakpoints, rewrites and scripts |
| `rule set` | Enable, disable or create a rule, or toggle a rule family |

Global flags: `--api-host <host>` (default `127.0.0.1`), `--api-port <port>` (default: Reqable's configured proxy port, else `9000`), `--json` (default on), `--pretty`, `--help`. In `capture list` and `capture export`, `--host` filters *records* by request host; it is not the API host.

Filter flags, shared by `capture list` and `capture export`: `--host`, `--url`, `--method`, `--code`, `--keyword`, `--regex`, `--case-sensitive`, `--ip`, `--app`, `--pid`. Several filters combine with AND.

## Output contract

Every command prints exactly one JSON object on stdout, and nothing else. Diagnostics stay off stdout unless `REQABLE_CLI_DEBUG=1`, which sends a stack trace to stderr.

```json
{"ok":true,"command":"capture list","data":{"ids":[7],"items":[...]},"meta":{"durationMs":14}}
{"ok":false,"command":"capture get","error":{"code":"NOT_FOUND","message":"Record with id 999999 not found","exitCode":5,"details":{"route":"/capture/live/get","status":404}},"meta":{"durationMs":7}}
```

Stable `data` fields per command:

| Command | `data` fields |
|---|---|
| `status` | `reachable`, `host`, `port`, `portSource`, `configPath`, `capture.status`, `switches.{sslProxying,accessControl,networkThrottling,secondaryProxy}`, `certificate`, `errors`, `hint` |
| `capture list` | `filters`, `filterSummary`, `totalMatched`, `returned`, `ids`, `items[]`, `mode`, and `hint` when nothing matched |
| `capture list` `items[]` | `id`, `uid`, `protocol`, `url`, `host`, `path`, `method`, `statusCode`, `statusText`, `responseMime`, `requestBodyBytes`, `responseBodyBytes`, `application`, `startedAt`, `remote` |
| `capture get` | `id`, `record`, plus `savedRecordTo` / `savedResponseBodyTo` when asked to write files |
| `capture curl` | `id`, `curl` (Reqable's text, Windows continuations), `curlSingleLine` |
| `capture export` | `format`, `entries`, `totalMatched`, `filters`, `writtenTo`, `bytes` |
| `capture clear` | `cleared` |
| `capture on` / `off` | `requested`, `status` |
| `replay` | `id`, `applied`, `request`, `response`, `durationMs`; with `--dry-run`, `plan` instead |
| `rule list` | `types`, `counts`, `totalRules`, `rules` |
| `rule set` | `type`, `action`, `applied`, and `ids`, `enabled`, `payload` or `created` depending on the action |

`status` is the one command that always exits 0. "Reqable is down" is a result, not a failure, so it is reported in `data.reachable`.

## Exit codes

| Code | Meaning | Retry? |
|---|---|---|
| 0 | Success | n/a |
| 1 | Internal error (a defect; `details.name` carries the exception type) | No |
| 2 | Usage error: unknown flag, missing positional, bad value, malformed payload JSON | After fixing the command |
| 3 | Reqable not reachable | After starting Reqable |
| 4 | Reqable answered with an error (`details.status`, `details.message`) | Depends on the message |
| 5 | Not found (no such record, rule or file) | After a fresh lookup |
| 6 | Confirmation required (pass `--yes`) | When discarding is intended |

`error.code` values: `USAGE`, `REQABLE_UNREACHABLE`, `REQABLE_API_ERROR`, `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `INTERNAL_ERROR`. The skill's `references/errors.md` carries the same set with the action per code.

## Record shape

`capture get` returns Reqable's record unchanged, under `data.record`:

```
protocol    "http" | "websocket"
id          integer, unique inside the current capture session only
uid         string, unique across sessions
url         string
connection  { id, timestamp, remote: { ip, port }, local: { ip, port } }
application { name, id?, path?, pid? }
request     { method, path, protocol, headers: [{ name, value }], body, scriptLogs[] }
response    { code, status, protocol, headers, body, scriptLogs[] } | null
messages    [ { flow, timestamp, payload } ]        (websocket only)
```

A body is `{ text, mime?, encoding }`, where `encoding` is `utf8`, `base64` or `file`. With `file`, `text` is a path on the machine running Reqable and the body is on disk; HAR export reads it.

Two consequences worth knowing:

- Record IDs are reused after `capture clear`. Take an ID from a list you just fetched.
- A record carries one timestamp, `connection.timestamp`. There is no per-phase timing, so `capture export` writes `time: -1` and `-1` in every `timings` phase, which is HAR 1.2's own value for "unavailable". Do not compute durations from a HAR this tool produced.

## Rule payloads

`rule set` forwards a create payload to Reqable verbatim, so the field names are Reqable's. The ones Reqable's own tooling documents:

| Rule type | Payload fields |
|---|---|
| `breakpoint` | `name*`, `url*`, `method`, `folderId`, `wildcard` (default true), `isRequestEnabled`, `isResponseEnabled` |
| `rewrite` | `name*`, `url*`, `action*`, `method`, `folderId`, `wildcard` (default true). `action` is a rewrite action object holding modify items, each with a `type` index (0 modify body, 1 add query, 2 modify query, 3 remove query, 4 add header, 5 modify header, 6 remove header) and a `modify` object whose fields depend on that type |
| `script` | `name*`, `url*`, `code*`, `method`, `folderId`, `wildcard` (default true) |

`*` marks required. Run `reqable-cli rule list --type <t>` to see the shape of the rules already in your Reqable, which is the most reliable reference.

Toggling is different: `rule set --enable <id>` and `--disable <id>` send `{ ids: [...], enabled }` to `/capture/<type>/enable|disable`, mirroring what Reqable's own MCP tool sends.

## Local API endpoints

Every route this CLI calls, extracted from the reqable-mcp-server Dart source. `docs/endpoints.md` is the authoritative record: it pins the source revision by file hash, lists the full route set with `file:line` for each, and records the routes that exist and are deliberately not called.

| Route | Method | Source | Used by |
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
| `/capture/{breakpoint,rewrite,script}/list` | GET | `breakpoint.dart:420`, `rewrite.dart:426`, `script.dart:443` | `rule list` |
| `/capture/{breakpoint,rewrite,script}/on` and `/off` | POST | `breakpoint.dart:411-412`, `rewrite.dart:417-418`, `script.dart:434-435` | `rule set --feature on\|off` |
| `/capture/{breakpoint,rewrite,script}/enable` and `/disable` | POST | `breakpoint.dart:429-430`, `rewrite.dart:435-436`, `script.dart:452-453` | `rule set --enable\|--disable` |
| `/capture/{breakpoint,rewrite,script}/create` | POST | `breakpoint.dart:448`, `rewrite.dart:454`, `script.dart:471` | `rule set --file\|--json` |

Three facts about this API that shaped the code:

- **No authentication.** No token, header, cookie or signature. `lib/api/client.dart:27` sets a User-Agent and nothing else, and a plain `curl` to the API works.
- **The port comes from Reqable's own configuration.** `lib/config.dart:56-79` reads `proxyPort` from `<storage root>/config/capture_config`, falling back to `9000`, where the storage root is platform-specific (`lib/utils/storage.dart:6-33`). The CLI mirrors that logic rather than asking you to configure a port.
- **The API and the capture proxy share one port, and Reqable classifies a connection by its first use.** A client that reuses a keep-alive socket from API calls for a proxy request gets its request answered by Reqable's internal server instead of being forwarded. `replay --via reqable` therefore opens a one-shot connection. Any other client of this API will hit this too.

Deliberately not exposed, with reasons in `docs/endpoints.md`: `/proxy/set` (it flips the machine's system proxy), the collection, environment and REST-tab routes (authoring, not analysis), and the long tail of capture features that need multi-step configuration in the GUI.

## The skill

`SKILL.md` is the entry point an agent loads, with `references/install-and-config.md` and `references/errors.md` for the rare paths. Chinese translations sit beside each file. The skill is self-contained: it names only the installed `reqable-cli` command and its own reference files, so it can be installed anywhere the CLI is.

Installing it as a skill means placing these at a skill path named `reqable-cli`:

```
reqable-cli/
  SKILL.md
  skill-zh.md
  references/install-and-config.md
  references/install-and-config-zh.md
  references/errors.md
  references/errors-zh.md
```

## Verification

```sh
node test/e2e.mjs            # full path, 43 checks
node test/e2e.mjs --keep     # same, and keep the sample HAR for inspection
```

The end-to-end script starts its own loopback HTTP target, turns capture on, pushes traffic through Reqable's proxy with a process-level `HTTP_PROXY`, then exercises list, get, curl, HAR export, both replay transports, the error paths and every help screen. It restores the capture state it found. No third-party host is contacted.

`docs/verification.md` records the answers to the six open questions this project started with, the route decision, and the findings that changed the plan. Every claim there carries a citation or a quoted command output.

## Repository hygiene

The repository contains no credential and no machine-specific path. To re-check:

```sh
grep -rniE "sk-[A-Za-z0-9]{8}|token|password|secret" --include="*.js" --include="*.md" .
grep -rn "C:\\\\Users\\\\" --include="*.js" src/ bin/     # expect no hits
```

Every local value (`APPDATA`, the Reqable config path, the port) is read at runtime.

## Layout

```
bin/reqable-cli.js        entry point
src/cli.js                command routing and help
src/args.js               argument parser and help rendering
src/reqable.js            local API client and port discovery
src/records.js            record shaping, HAR 1.2 export, curl normalisation
src/filters.js            shared filter flags to Reqable's filter payload
src/output.js             JSON envelope and exit-code plumbing
src/errors.js             error taxonomy
src/commands/status.js    status
src/commands/capture.js   capture list, get, curl, export, clear, on, off
src/commands/replay.js    replay
src/commands/rule.js      rule list, rule set
test/e2e.mjs              end-to-end check
docs/endpoints.md         endpoint record with source citations and hashes
docs/verification.md      verification record and route decision
SKILL.md                  the agent-facing skill
```

## Non-goals

- Not a port of the hundred-plus MCP tools.
- Not a replacement for Reqable's GUI, and not a replacement for its API testing tabs.
- Does not register, host or distribute an MCP server.
- Does not modify the Reqable installation or its settings. It never turns the system proxy on.
- Not tuned for cross-platform polish: it was built and verified on Windows, and the platform-specific path logic follows Reqable's own.
