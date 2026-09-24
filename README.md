# reqable-cli

A command-line front end for [Reqable](https://reqable.com)'s local capture API, plus a skill that teaches an AI agent to use it. It exists so an agent can read captured traffic without registering an MCP server.

## Why not the MCP server

Reqable's only official AI interface is `reqable-mcp-server`, an MCP server that exposes more than a hundred tools. Registering an MCP server injects its whole tool list into every request's system prompt, and a hundred tool names is a poor trade for what traffic analysis actually needs: see what was captured, filter it, pull one exchange out in full, export it, re-send it.

This CLI does not re-expose a hundred tools. It exposes ten entry points shaped around the tasks an agent has, and each writes one JSON object to stdout.

## Install

```sh
npm install -g reqable-cli        # from the registry
reqable-cli --version
reqable-cli skill install         # write the bundled agent skill into ~/.agents/skills
reqable-cli status                # is Reqable reachable, and is capture on
```

Installing from a checkout instead:

```sh
npm link                          # from this directory; puts reqable-cli on PATH
npm test                          # unit checks; needs no Reqable and no network
```

No runtime dependencies, so no network fetch is needed. **Node.js 20.11 or newer** — `skill install` resolves its own package directory with `import.meta.dirname`, which is `undefined` on 18 and would fail as an internal error. `package.json` declares the same floor in `engines`.

Pick the release that matches your Reqable, when you are on an older one: `npm install -g reqable-cli@reqable-3.2`. See "Publishing and Reqable versions".

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

Every command prints exactly one JSON object on stdout, and nothing else. Diagnostics stay off stdout unless `REQABLE_CLI_DEBUG=1`, which sends a stack trace to stderr. Because stdout is reserved for that envelope, `capture export --out -` is refused: two JSON documents on one stream is not parseable. Give `--out` a real file.

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

Creating or deleting a rule needs a signed-in Reqable account. Without one, `create` and `delete` answer `401` with `"Creating <type> requires an account, please login to your Reqable account."`, which the CLI surfaces as exit 4 with that message. Listing, the `--feature` switches, and the `{ ids, enabled }` toggle body all work without an account, and Reqable's own validation of that body is what the supplementary check asserts.

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
| `/capture/{breakpoint,rewrite,script}/create` | POST | `breakpoint.dart:448`, `rewrite.dart:454`, `script.dart:471` | `rule set --file\|--payload` |

Three facts about this API that shaped the code:

- **No authentication.** No token, header, cookie or signature. `lib/api/client.dart:27` sets a User-Agent and nothing else, and a plain `curl` to the API works.
- **The port comes from Reqable's own configuration.** `lib/config.dart:56-79` reads `proxyPort` from `<storage root>/config/capture_config`, falling back to `9000`, where the storage root is platform-specific (`lib/utils/storage.dart:6-33`). The CLI mirrors that logic rather than asking you to configure a port.
- **The API and the capture proxy share one port, and Reqable classifies a connection by its first use.** A client that reuses a keep-alive socket from API calls for a proxy request gets its request answered by Reqable's internal server instead of being forwarded. `replay --via reqable` therefore opens a one-shot connection. Any other client of this API will hit this too.

Deliberately not exposed, with reasons in `docs/endpoints.md`: `/proxy/set` (it flips the machine's system proxy), the collection, environment and REST-tab routes (authoring, not analysis), and the long tail of capture features that need multi-step configuration in the GUI.

## The skill

`SKILL.md` is the entry point an agent loads, with `references/install-and-config.md` and `references/errors.md` for the rare paths. Chinese translations sit beside each file. The skill is self-contained: it names only the installed `reqable-cli` command and its own reference files, so it can be installed anywhere the CLI is.

`reqable-cli skill install` writes the six files to a skill directory, `~/.agents/skills/reqable-cli` by default. It reads them from inside the installed package, so it does not care where you ran it from, and it refuses to replace an existing install without `--force`:

```sh
reqable-cli skill install --dry-run            # where it would write, and which files
reqable-cli skill install                      # ~/.agents/skills/reqable-cli
reqable-cli skill install --dir ./skills       # somewhere else
reqable-cli skill install --force              # replace; the target directory is removed first
```

The layout it produces:

```
reqable-cli/
  SKILL.md
  skill-zh.md
  references/install-and-config.md
  references/install-and-config-zh.md
  references/errors.md
  references/errors-zh.md
```

Installing the skill is a setup action, not part of the traffic interface: an agent mid-task never calls it. It is the one entry point that does not talk to Reqable at all, and it takes none of the transport flags.

## Verification

```sh
npm test                     # unit checks; no Reqable, no network, 27 checks

node test/e2e.mjs            # the main path, 43 checks
node test/e2e.mjs --keep     # same, and keep the sample HAR for inspection

node test/e2e-extra.mjs      # the paths the main check leaves out, 49 checks

npm run check                # all three, in order
```

`npm test` is the one that runs anywhere: it covers the port discovery rule against fixtures, the version-line constants, argument parsing, and — by spawning the CLI — that a rejected `--api-port` still prints one JSON object and exits 2 rather than a stack trace. The two `e2e` scripts need Reqable running.

`test/e2e.mjs` starts its own loopback HTTP target, turns capture on, pushes traffic through Reqable's proxy with a process-level `HTTP_PROXY`, then exercises list, get, curl, HAR export, both replay transports, the error paths and every help screen.

`test/e2e-extra.mjs` covers what the main check deliberately avoids: the file output paths (`--format json`, `--out`, `--body-out`, compared byte for byte), an `https` target intercepted by Reqable with a readable decrypted body and replayed through the proxy with and without `--insecure`, and the rule surface. It mints a short-lived self-signed certificate with `openssl` for its TLS target.

Both scripts restore what they touched and then assert it: rule counts, rule feature flags, the capture switch, and the hash of Reqable's config file. No third-party host is contacted.

`docs/verification.md` records the answers to the six open questions this project started with, the route decision, the findings that changed the plan, and the results of both scripts.

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
src/commands/skill.js     skill install, for setup only
test/unit.test.mjs        unit checks that need no Reqable
test/e2e.mjs              end-to-end check
test/e2e-extra.mjs        file output, HTTPS and the rule surface
scripts/check-version-line.mjs   guards the branch and Reqable-line pairing
docs/endpoints.md         endpoint record with source citations and hashes
docs/verification.md      verification record and route decision
SKILL.md                  the agent-facing skill
```

## Publishing and Reqable versions

Reqable's local API is undocumented and it changes between releases. This package therefore publishes one release line per Reqable line, and `main` always tracks the newest one this project supports.

| Branch | What it tracks | npm dist-tag | Install it with |
| --- | --- | --- | --- |
| `main` | the newest supported Reqable line | `latest` | `npm i -g reqable-cli` |
| `reqable-3.2` | frozen at the last build that worked against Reqable 3.2 | `reqable-3.2` | `npm i -g reqable-cli@reqable-3.2` |

When Reqable 3.3 arrives and this CLI is brought up to it, the order is: branch `reqable-3.2` off the last commit that worked, move `main` to 3.3, then publish the frozen line with its own tag (`npm publish --tag reqable-3.2` from that branch). `npm i -g reqable-cli` keeps handing out the newest line, and the older one stays reachable by name.

Two constants carry the pairing, and a test plus a publish-time guard keep them honest:

- `src/reqable.js` exports `SUPPORTED_REQABLE` (`3.2`) and `VERIFIED_REQABLE` (`3.2.23`); `package.json` mirrors them under `reqable`. `npm test` fails if the two disagree.
- `npm run check:line` fails when a `reqable-<X.Y>` branch carries a different `SUPPORTED_REQABLE`, and skips when HEAD is detached. `prepublishOnly` runs it, so a mismatch cannot be published from the wrong branch.

`prepublishOnly` also runs `npm test`. Neither it nor `check:line` needs Reqable running, so publishing works on a clean machine; the two `e2e` scripts are manual and never run at publish time.

To publish:

```sh
npm run check:line         # refuse to publish a branch whose line disagrees
npm test
npm publish                # or: npm publish --tag reqable-3.2, from that branch
```

Publishing from a machine whose npm registry is a mirror writes to that mirror, not to registry.npmjs.org — check with `npm config get registry` first, because it fails silently otherwise.

The lines are not the only signal: `reqable-cli status` reads the Reqable version installed locally and reports it next to the supported line, so a user on a release this build was not written against sees it in the first call rather than as a mystery 404 later.

## Non-goals

- Not a port of the hundred-plus MCP tools.
- Not a replacement for Reqable's GUI, and not a replacement for its API testing tabs.
- Does not register, host or distribute an MCP server.
- Does not modify the Reqable installation or its settings. It never turns the system proxy on.
- Not tuned for cross-platform polish: it was built and verified on Windows, and the platform-specific path logic follows Reqable's own.
