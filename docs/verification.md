# Verification record

Answers to the six open questions the project started with, the route decision that follows from them, and the findings that changed the plan. Each answer carries evidence that can be re-checked: a source citation with a file and line, or a command whose output is quoted.

The sketch that posed those six questions is not part of this repository; it is kept with the project's private documents, and this file stands on its own. Where the text below says "the sketch", it means that original document.

## One answer per open question

### 1. The complete endpoint table of Reqable's local API

**Confirmed.** The endpoints are not documented upstream, but they are fully visible in the Dart source as route string literals, and they work as written when called. A grep for quoted path literals across `lib/` yields 164 distinct strings. Of those, 29 are the routes the CLI calls, and every one is listed with its source line in `docs/endpoints.md`, together with the ones available but unused and the ones deliberately excluded.

Evidence: the route literals were extracted by grepping for quoted path literals across `lib/`, each recorded with its `file:line`. Confirmed live by calling a sample of them directly and reading the responses, for example `GET /capture/live/status` returning `{"status":"inactive"}` and `POST /capture/live/filter` returning a JSON array of record ids.

### 2. The API's authentication

**Confirmed: there is none.** No token, no header, no cookie, no query signature.

Evidence, from the source:

- `lib/api/client.dart:27` sets only a User-Agent, `reqable-mcp/<version>`.
- `lib/api/client.dart:50-55` adds a JSON content type and body, and nothing else.
- `lib/api/client.dart:46` uses the route verbatim as the URL path on `host:port`.

Evidence, from the live instance: `curl -s http://127.0.0.1:9000/capture/live/status` returns `{"status":"inactive"}` with no credential supplied.

Consequence for the CLI: it reads no secret from anywhere, so no key can leak into this repository. It sends a User-Agent identifying itself as `reqable-cli/1.0.3`.

### 3. The default port discovery logic

**Confirmed.** The port is not configured by the CLI's user in the normal case: it is read from Reqable's own configuration file, with `9000` as the fallback.

Evidence, from the source:

- `lib/config.dart:10-11`: `_kDefaultHost = '127.0.0.1'`, `_kDefaultPort = 9000`.
- `lib/config.dart:56-79`, `_resolveAppPort()`: builds `<storage root>/config/capture_config` and returns its `proxyPort` field, or `null` when the file is missing or unparsable.
- `lib/utils/storage.dart:6-33`, `Storage.rootPath`: `%APPDATA%\Reqable` on Windows, `~/Library/Application Support/com.reqable.macosx` on macOS, `~/.local/share/com.reqable.linux` on Linux.

Evidence, from the live instance: `%APPDATA%\Reqable\config\capture_config` contains `{"proxyPort":9000,...}`, and `netstat -ano` shows port 9000 owned by the `Reqable.exe` process.

Note the consequence the sketch did not anticipate: this is also the port the capture proxy listens on, because the API and the proxy are the same server. One port, two roles, and the roles are told apart by the shape of the connection rather than by the port number. That has a real consequence for clients, recorded under "Findings that changed the plan" below.

### 4. Does Reqable have an official CLI?

**Refuted: no.** Capture control has no command-line surface. This item was listed in the sketch as a case where the task might degrade into "write a skill that teaches an agent to use the vendor CLI"; it does not, because there is no such CLI.

Evidence:

- The npm package `reqable-mcp-server@1.0.2` declares exactly one `bin`, `reqable-mcp-server` → `bin/mcp-server.js`, and that script only locates and spawns a platform binary with `stdio: 'inherit'` (`npm/bin/mcp-server.js`). It is an MCP stdio server, not a CLI.
- The Windows install directory `C:\Program Files\Reqable\` contains `Reqable.exe` and `mcp-server.exe` plus shared libraries. Grepping its file list for `cli`, `cmd`, `console` and `shell` returns nothing.
- The `mcp-server.exe` that ships in the install directory is the same MCP stdio server, so it is not an alternative path either.

### 5. Does the local API require the Reqable GUI process to be running?

**Confirmed: yes.** The API is served by the application process itself, so it exists only while that process does.

Evidence:

- The listening socket on port 9000 belongs to `Reqable.exe` (`netstat -ano`, PID cross-checked with `tasklist`).
- Reqable's own log records each CLI call as an incoming request to its internal server, for example `09-25 02:47:28 [V][Dart]: Internal Server >> GET capture/live/status`. The log file lives under `%APPDATA%\Reqable\log\`.

Consequence for the deliverable: `reqable-cli` is positioned as a structured assistant for when Reqable is open, not as an unattended capture backend. The CLI states this rather than hiding it: `status` reports `reachable`, and an unreachable API exits 3 with a message naming the application.

### 6. Can the `reqable-scripting` framework run outside the GUI?

**Refuted: no, it cannot usefully run standalone.** The package is an executor that the application drives, not a capture engine.

Evidence: `reqable-scripting` 1.2.0 was downloaded from PyPI and unpacked. The package is one small pure-Python library. Its `reqable/main.py` takes exactly two arguments, a type (`request` or `response`) and a path to a JSON file, loads the user's `addons.py`, calls `addons.onRequest` or `addons.onResponse`, and writes the result to `<path>.cb`. It has no networking, no capture, and no way to obtain traffic by itself: the application supplies the payload file and consumes the callback file.

Consequence: route C (drive Reqable's Python script layer) cannot serve as a headless capture backend. It remains useful only as a way to transform traffic inside a running Reqable, which is a different task.

## Route decision

**Route A was chosen: the CLI calls Reqable's local API directly.** The three conditions the sketch attached to route A all hold:

| Condition | Result |
|---|---|
| The local API endpoints can be extracted | Yes, 164 path literals found in the source, 29 of them called by the CLI, each with a source citation (`docs/endpoints.md`). |
| The API can be called directly, without an MCP server | Yes, plain HTTP with JSON and no authentication. Verified by calling it. |
| The dependency it imposes is acceptable | Reqable must be running. Accepted, and stated in the deliverable rather than worked around. |

Route B (drive the MCP server over JSON-RPC) was rejected: it keeps an MCP server process alive, which is the cost this task exists to remove, and it adds a stdio protocol layer on top of the same API.

Route C (the Python script framework) was rejected as the primary route because item 6 refutes it as a headless option. It is named in the skill as the tool for transforming traffic inside Reqable when a script is genuinely needed.

## Findings that changed the plan

Four things found during implementation that the sketch did not anticipate. Each one changed either the CLI or what the documentation has to say.

| Finding | Evidence | What changed |
|---|---|---|
| There is no export endpoint at all, and specifically no HAR endpoint | Grepping the whole source for `export` and `har` finds only `lib/tools/capture/report_server.dart:381`, where Reqable *pushes* HAR to a remote receiver. No route returns a HAR document. | `capture export` assembles the HAR client side from `filter` plus `get`. The record has no per-phase timing, so `time` and every `timings` field are written as `-1`, HAR 1.2's own "unavailable" value, and both the CLI help and the skill say so. |
| `filter` returns record IDs only, never bodies | Live: `POST /capture/live/filter` with `{"filters":[]}` answers `[20,21]`. The output schema for the tool confirms it: `items` is an array of ids (`lib/tools/capture/live.dart:686-698`). | `capture list` is two calls deep by design: filter, then get each record. `--ids-only` exposes the cheap path, and `--limit` bounds the work. |
| A POST that carries no JSON content type is unreliable | A bare POST to `/capture/live/on` returned 200 and left the engine inactive in one run; the same POST with `content-type: application/json` and a `{}` body started it and produced Reqable's `capture_engine_start` event. A later bare POST did start it, so the behaviour is inconsistent rather than simply broken. | The API client always sends a JSON content type and a body on POST, including for routes that take no arguments. |
| The API port and the proxy port are one socket, and Reqable classifies a connection by its first use | Forcing `replay --via reqable` to reuse the keep-alive socket that the same process had used for API calls made Reqable answer from its internal server (`{"message":"Route not found.","status":404}`) and never forward the request: Reqable's log showed `Internal Server >> GET seed` for a proxy request aimed at a different port. Opening a one-shot connection made the same request reach the target, verified by counting hits on the target server. | `replay --via reqable` passes `agent: false` so it never shares a socket with the API client. This is documented in `docs/endpoints.md` because any other client of this API will hit it. |

One sketch assumption turned out to be simply wrong and is worth recording: the initial suspicion that Reqable refuses to proxy loopback targets. It does not. Loopback targets are forwarded and captured normally, for `GET`, `POST` and error responses. The empty replies seen early on came from a test server that had already exited, not from Reqable.

## Supplementary verification: the three paths the first round left out

The first round stopped at three paths because each needed state it was not authorized to touch. They were approved and run in the second round, in `test/e2e-extra.mjs`, 49 checks, all passing. What each one settled:

| Path | Result |
|---|---|
| File output: `capture export --format json`, `capture get --out`, `capture get --body-out` | **Verified.** The JSON export is a `{ records: [...] }` document holding Reqable's records unchanged, bodies included. `--out` writes a file whose parsed content equals the record printed on stdout. `--body-out` writes bytes byte-identical to the recorded body (106 bytes, sha256 `f99eb4c6dd151e42` prefix). |
| `https` target captured through Reqable | **Verified.** A loopback TLS server with a self-signed certificate, requested through the proxy, produced a record whose response body was plain JSON of exactly the expected size, so the TLS really was intercepted. `replay --via reqable --insecure` re-sent that record through the proxy, reached the target (hit count +1) and answered 200. |
| Rule state changes | **Partly verified, and the rest is now a documented licence gate, not an open question.** The `--feature on|off` switch works for all three rule types, verified through Reqable's own config endpoint. The `{ ids, enabled }` body the CLI sends is accepted by Reqable (200) while a missing or wrongly typed `ids` is rejected (400), which proves the payload shape without needing a rule. Creating or deleting a rule is refused with `401 "requires an account"` on this install, and the CLI surfaces exactly that as exit 4. A live rule therefore cannot be created here without signing in, which is a property of the Reqable edition, not of the CLI. |

Two defects were found and fixed while running these:

| Defect | Why it existed | Fix |
|---|---|---|
| `capture export --out -` printed the document and then the envelope, putting two JSON documents on stdout | The stdout branch was written before the single-envelope rule was applied to it | `--out -` is refused with a usage error; stdout stays reserved for the envelope |
| `replay --via reqable` for an `https` target failed with `socket hang up` | The `CONNECT` request reused the keep-alive socket the same process had used for API calls, so Reqable read it as another API call and hung up. This is the connection-classification trap again, on the tunnel rather than on the request | The `CONNECT` now opens its own connection, and SNI is omitted for IP-literal targets |

One observation that is not a defect: pointing `curl --cacert <Reqable CA>` at the interception certificate did not satisfy the handshake on this machine, and neither did `replay --via reqable` without `--insecure`; both needed the verification to be waived. That is the expected consequence of a MITM proxy presenting its own certificate, and it is why `--insecure` exists and why the skill says to install the CA in the client's trust store.

Both new checks assert restoration rather than assuming it: rule counts and feature flags return to their starting values, the capture switch returns to its starting state, and Reqable's config file hash is unchanged.

## What was verified how

| Claim | How it was checked |
|---|---|
| The end-to-end path works | `node test/e2e.mjs`, 43 checks, all passing: capture on, traffic pushed through the proxy with a process-level `HTTP_PROXY`, list, get, curl, HAR export, both replay transports, error paths, and help output. |
| The three paths the first round left out work | `node test/e2e-extra.mjs`, 49 checks, all passing: file output compared byte for byte, an `https` target intercepted with a readable body plus replay through the proxy, and the rule surface. Details in the section above. |
| The endpoints the CLI calls match the table | Reverse grep: every route literal in `src/reqable.js` appears in `docs/endpoints.md`. |
| No MCP server is involved | No `mcp-server` or `reqable-mcp` process was running during the test; no MCP client configuration on this machine contains a `reqable` server entry. |
| Reqable's own settings were left alone | The hash of `%APPDATA%\Reqable\config\capture_config` is identical before and after the work: `698cf27ad1d88b56ac6775ba93e2fdb8`. Capture was returned to `inactive`, which is the state it was in before the work started. |
| The system proxy was never touched | `/proxy/set` is never called; it does not appear in `src/` at all. |
| No secret or machine-specific path is baked into the source | All local values are read at runtime. See the check in `README.md` under "Repository hygiene". |
