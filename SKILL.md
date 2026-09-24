---
name: reqable-cli
description: Inspect captured HTTP traffic, export a capture session to HAR, replay a captured request, and switch Reqable breakpoints, rewrites and scripts on and off from a shell. Triggers on finding out what an application sent to an API, filtering a capture by host, method, status code or keyword, pulling one request and response out with their bodies, exporting a session for someone else to open, re-sending a captured request, and adding or disabling a Reqable interception rule. It drives the reqable-cli command, which speaks to Reqable's own local capture API, so no MCP server is involved.
---

# reqable-cli: work with captured HTTP traffic

`reqable-cli` is a shell front end for Reqable, the desktop HTTP debugging proxy. It asks Reqable's own local HTTP API for captured records and prints one JSON object per invocation. Reqable must be installed and running, because the API is served by the Reqable application process itself. Setup, prerequisites and configuration keys are in `references/install-and-config.md`.

## Output boundary

This skill reads and moves traffic data. It does not:

- tell you whether a captured exchange is correct, expected, or a bug: you interpret the data.
- make traffic appear. Records exist only if a client was routed through Reqable's proxy while capture was running; the skill cannot capture a request that never went through the proxy.
- decide who may be intercepted. Authorization for a target is the caller's responsibility, and no command in this skill establishes it.
- replace Reqable's GUI. Anything the CLI does not expose (session search history, collection editing beyond the rule endpoints, certificate installation) is done in the application.
- register, start or configure an MCP server.

## How to read this skill

Sentences with "must", "do not" or "the criterion is" are rules. Tables are reference: read the row you need and skip the rest. Fenced blocks show a call's shape and are safe to adapt. Two files hold the rare paths and are not read on a normal call:

| File | Holds |
|---|---|
| `references/install-and-config.md` | Getting `reqable-cli` onto the machine, prerequisites, configuration keys with defaults, and how traffic gets into Reqable in the first place |
| `references/errors.md` | The full exit code and error code set, one action per code, and which failures may be retried |

`references/install-and-config.md` also holds the health check to run when a call cannot reach Reqable.

## The lifecycle

Two things must exist before any call that reads traffic:

1. The Reqable application is running on the same machine, or on the host you are talking to. `reqable-cli status` reports this as `data.reachable`.
2. Capture is running. `reqable-cli capture on` starts it; `data.capture.status` must read `active` before any record can exist.

Records live in memory only and belong to the current capture session. Closing Reqable, or running `capture clear`, discards them, and record IDs restart. A rule change (a breakpoint, a rewrite or a script) outlives the run and affects traffic until it is turned off.

## The loop

```sh
reqable-cli capture on
# route a client through Reqable's proxy, then let it make the request you care about
reqable-cli capture list --limit 20
reqable-cli capture get <id>
```

The mistake callers make: reading an ID from a list taken before a `capture clear`, or from a different session. IDs are reused, so take the ID from the list you are looking at, then use it immediately.

## Command usage

```sh
reqable-cli <command> [subcommand] [required positionals] [flags]

# inspect the newest POST to one host, then pull the record out in full
reqable-cli capture list --host api.example.com --method POST --limit 5
reqable-cli capture get 42
```

- `reqable-cli capture get 42` takes `<id>` as a positional, after the subcommand. Flags follow it.
- `--help` is the runtime source of truth for a signature. Run `reqable-cli <command> --help` rather than trusting a flag list from memory; every command and subcommand answers it on stdout and exits 0.
- Output is one JSON object on stdout. Success is `{"ok":true,"command":"...","data":{...},"meta":{...}}`; failure is `{"ok":false,"command":"...","error":{"code":"...","message":"...","exitCode":N}}`. Read `data` on success and `error.code` on failure. Nothing else is written to stdout, so the output goes straight into a JSON parser.
- Global flags, accepted by every command:

| Flag | Meaning |
|---|---|
| `--api-host <host>` | Reqable API host. Default `127.0.0.1`. This is where the API is, not what to filter on. |
| `--api-port <port>` | Reqable API port. Default comes from Reqable's own configuration, else `9000`. |
| `--json` | Machine-readable output on stdout. On by default; passing it is harmless. |
| `--pretty` | Indent the JSON. For reading, not for parsing. |
| `--help` | Print help for the command and exit 0. |

Note the two similarly named flags: `--api-host` is the API endpoint, and in `capture list` and `capture export` the record filter is `--host`. They are different things.

## Command surface

| Group | Commands |
|---|---|
| Session state | `status`, `capture on`, `capture off`, `capture clear` |
| Reading records | `capture list`, `capture get`, `capture curl`, `capture export` |
| Sending traffic | `replay` |
| Rules | `rule list`, `rule set` |

Filter flags are shared by `capture list` and `capture export` and are listed once below. The per-command tables do not repeat them.

| Filter flag | Meaning |
|---|---|
| `--host <h>` | Match the request host exactly. Repeat or comma-separate for several. |
| `--url <u>` | Match the request URL exactly. |
| `--method <m>` | Match the HTTP method, for example `GET` or `POST`. |
| `--code <c>` | Match the response status code, for example `200` or `404`. |
| `--keyword <k>` | Match a keyword across URL, headers and bodies. |
| `--regex` | Treat `--keyword` as a regular expression. |
| `--case-sensitive` | Make `--keyword` matching case sensitive. |
| `--ip <ip>` | Match the remote IP address. |
| `--app <name>` | Match a client application name substring. |
| `--pid <n>` | Match a client application process id. |

Several filters combine with logical AND.

Session state:

| Command | Description | Parameters | Notes |
|---|---|---|---|
| `status` | Report whether Reqable is reachable and which capture features are active. | `--pretty` | Always exits 0, including when Reqable is down: `data.reachable` carries the answer, and `data.errors` and `data.hint` say why. Start here when any other command fails. |
| `capture on` | Start capture so that proxied traffic is recorded. | | Routing is not changed by this. Point the client at the proxy yourself. |
| `capture off` | Stop capture. | | Records already collected stay readable while Reqable keeps running. |
| `capture clear` | Discard every retained record. | `--yes*` | Clears the session and restarts the ID space. Refused with exit 6 when `--yes` is missing. |

Reading records:

| Command | Description | Parameters | Notes |
|---|---|---|---|
| `capture list` | List captured requests, optionally filtered. | `--limit <n>` `--sort <newest\|oldest>` `--ids-only` | `--limit` defaults to 50, and `0` means no limit. Returns `data.items[]` with `id`, `uid`, `protocol`, `url`, `host`, `path`, `method`, `statusCode`, `statusText`, `responseMime`, `requestBodyBytes`, `responseBodyBytes`, `application`, `startedAt`, `remote`. With `--ids-only`, only `data.ids` is filled, and the call is much cheaper. |
| `capture get <id>` | Fetch one record with its full request, response and bodies. | `<id>` `--out <file>` `--body-out <file>` | `data.record` holds the raw record. `--body-out` writes the response body decoded to raw bytes. |
| `capture curl <id>` | Produce a cURL command that reproduces the request. | `<id>` | `data.curl` is Reqable's own text, which uses Windows cmd line continuations; `data.curlSingleLine` is the same command joined into one POSIX line. |
| `capture export` | Write records to a HAR 1.2 or raw JSON file. | `--out <file>*` `--format <har\|json>` `--limit <n>` `--sort <s>` | `--format` defaults to `har`, `--limit` to 50. `--out` is required; `--out -` writes the document to stdout. Reports `data.writtenTo` and `data.bytes`. |

Sending traffic:

| Command | Description | Parameters | Notes |
|---|---|---|---|
| `replay <id>` | Re-send a captured request and report the response. | `<id>` `--via <direct\|reqable>` `--proxy <url>` `--header <h>` `--method <m>` `--url <u>` `--body <text>` `--timeout <ms>` `--max-body <bytes>` `--full` `--insecure` `--dry-run` | `--via` defaults to `direct`, which calls the origin directly. `--via reqable` sends through Reqable's proxy so the replay is captured again, and needs `--insecure` for an `https` target because Reqable intercepts it with its own certificate. `--dry-run` reports the request without sending it. Host, content-length, connection and transfer-encoding come from the recorded request or are rebuilt. |

Rules:

| Command | Description | Parameters | Notes |
|---|---|---|---|
| `rule list` | List breakpoints, rewrites and scripts. | `--type <all\|breakpoint\|rewrite\|script>` | Defaults to `all`. `data.rules` holds Reqable's own rule objects per type, `data.counts` the totals. |
| `rule set` | Enable, disable or create a rule, or toggle a whole rule feature. | `--type <breakpoint\|rewrite\|script>*` `--feature <on\|off>` `--enable <id>` `--disable <id>` `--file <file>` `--json <json>` `--dry-run` | Exactly one action flag per call. `--type` is required. A create payload is forwarded to Reqable verbatim, so its field names are Reqable's; `rule list --type <t>` shows the shape of the rules already there. |

Parameter marks: `<x>` required positional, `--flag` optional flag, `--flag*` required flag, `a | b` alternatives.

`install-and-config.md` holds the install commands, the prerequisites, the configuration keys and their defaults, and how to route a client through Reqable.

## Reading the world

Reqable's data model has its own identity and encoding rules. Read these before interpreting a record.

| Item | Rule |
|---|---|
| Record ID | An integer, unique inside the current capture session only. It is reused after `capture clear`. Never reuse an ID across a clear, and never assume an ID from an earlier session still means the same request. |
| Record UID | A UUID that is unique across sessions. Prefer it when you store a reference, and resolve it back through a fresh `capture list`. |
| Response null | `data.record.response` is `null` while a response has not arrived, and stays `null` for a connection the client aborted. A null response is not an error, and such a record has no status code. |
| Body payload | A body is `{ text, mime, encoding }`. `encoding` is `utf8`, `base64` or `file`. For `file`, `text` is a path on the machine running Reqable, and the body itself is on disk. |
| Filter mechanics | A filter returns record IDs only, never bodies. `capture list` resolves each ID with a second call, so `--ids-only` is the cheap path and `--limit` bounds the work. |
| HAR timings | Every timing field is `-1`, which is HAR 1.2's value for "unavailable", because Reqable reports no per-phase timing for a live record. Only `startedDateTime` is real. Do not compute a duration from a HAR this tool produced. |
| WebSocket records | `protocol` is `websocket` and `data.record.messages[]` holds the frames. HTTP fields such as `response` may be absent. |
| Capture scope | A record exists only because a client addressed Reqable's proxy. An application that ignores proxy settings, or traffic that bypasses the proxy, cannot appear, no matter what the filters say. |

## Red lines

- Do not intercept, replay or rewrite traffic for a target you are not authorized to test. Every command here acts on real traffic: `capture on` starts recording every proxied exchange, and `replay` and `rule set` change what a real server sees or what a real client receives.
- Do not turn a rule feature on to "look around". `rule set --type <t> --feature on` changes interception for every matching request on the machine, not only for the traffic you were analysing.
- Do not route traffic by changing system proxy settings. This CLI never does, and nothing here needs it. Point the client at the proxy with `HTTP_PROXY` or with the application's own proxy setting.
- Do not replay without checking first. Run `replay <id> --dry-run`, then send. A replay repeats whatever side effect the original request had.
- Do not run `capture clear` to tidy up while someone else is reading the session. It destroys the ID space everyone else depends on.
- Do not present a capture as complete. It only ever contains what went through the proxy while capture was on.

## Errors

Branch on the exit code, not on the message text. The codes you will meet most:

| Exit | `error.code` | Action |
|---|---|---|
| 0 | (none) | Success. Read `data`. |
| 2 | `USAGE` | The invocation is wrong: an unknown flag, a missing positional, or bad JSON for `--json`. Fix the command; read `reqable-cli <command> --help`. |
| 3 | `REQABLE_UNREACHABLE` | Reqable is not running, or the API port is wrong. Start Reqable, then run `reqable-cli status`. |
| 4 | `REQABLE_API_ERROR` | Reqable answered with an error, for example a filter payload it rejected. Read `error.details.message`. |
| 5 | `NOT_FOUND` | No such record, or a file that is not there. Re-list records and take a fresh ID. |
| 6 | `CONFIRMATION_REQUIRED` | `capture clear` needs `--yes`. Re-run with it only when discarding the session is intended. |

Every code, every exit status, and which failures are worth retrying are in `references/errors.md`.
