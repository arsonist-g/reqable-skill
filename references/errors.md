# Errors and exit codes

Read this when a `reqable-cli` call exited non-zero and the action is not already obvious from the one-line message. On a successful call you do not need this file.

Every failure still prints a JSON object on stdout, so parse it rather than scraping stderr:

```json
{"ok":false,"command":"capture get","error":{"code":"NOT_FOUND","message":"Record with id 999999 not found","exitCode":5,"details":{"route":"/capture/live/get","status":404,"method":"POST"}},"meta":{"durationMs":7}}
```

Branch on `error.code` first, and on the process exit status when you are driving the CLI from a shell.

## Exit codes

| Exit | `error.code` | Meaning | Retry? |
|---|---|---|---|
| 0 | (none) | Success. `data` carries the result. | Not applicable. |
| 1 | `INTERNAL_ERROR` | A defect in the CLI, or an unexpected exception. `error.details.name` carries the exception type. | No. Report it with the exact invocation. Set `REQABLE_CLI_DEBUG=1` to get a stack trace on stderr. |
| 2 | `USAGE` | The invocation was rejected before anything was sent: an unknown flag, a missing required positional, a value of the wrong type, or payload JSON that does not parse. | Yes, after fixing the command. |
| 3 | `REQABLE_UNREACHABLE` | The CLI could not talk to Reqable at `--api-host`:`--api-port`. Reqable is closed, not installed, or listening elsewhere. | Yes, after starting Reqable. |
| 4 | `REQABLE_API_ERROR` | Reqable answered with a non-2xx status. `error.details.status` carries it and `error.details.message` carries Reqable's own text. | Depends on the message. A rejected filter payload is not retryable; a transient 5xx is. |
| 5 | `NOT_FOUND` | Reqable answered 404: the record, rule or resource does not exist. Lowercase `NOT_FOUND`, distinct from the JSON shape Reqable returns for a route the CLI itself does not expose. | Yes, after taking a fresh ID or path. |
| 6 | `CONFIRMATION_REQUIRED` | A destructive command was invoked without its acknowledgement flag. | Yes, once discarding the data is intended. |

## Error codes and the action for each

| `error.code` | Action |
|---|---|
| `USAGE` | Read `reqable-cli <command> --help` and rebuild the command. `details` is usually absent, and the message names the offending flag or argument. |
| `REQABLE_UNREACHABLE` | Run `reqable-cli status`. If `data.reachable` is `false`, start Reqable. Adjust `--api-port` only when you know Reqable is listening on another port. See `install-and-config.md`. |
| `REQABLE_API_ERROR` | Read `error.details.message`. A filter Reqable rejected means one of the filter values is not in the shape it expects. A 401 whose message says something "requires an account" is a licence limit on creating or deleting a rule, not a defect: report it, do not retry, and do not look for a flag that bypasses it. A 500 from Reqable is worth one retry, then report it. |
| `NOT_FOUND` | The ID was wrong or the record was cleared between the list call and this one. Run `capture list` again and use an ID from that result. |
| `CONFIRMATION_REQUIRED` | For `capture clear`, re-run with `--yes`. There is no other command behind this code. |
| `INTERNAL_ERROR` | Nothing to retry. Capture the invocation, the `error.message`, `error.details.name`, and the output of `REQABLE_CLI_DEBUG=1 reqable-cli ...`. |

## Failure shapes that are not errors

| What you see | What it means |
|---|---|
| `ok: true` with an empty `data.items` and a `data.hint` | Nothing matched. The hint says whether capture was off or the filters were simply too narrow. A hint naming capture as inactive means the traffic never reached Reqable. |
| `ok: true` with `data.items[].statusCode` null | The record has no response: still in flight when it was read, or the client aborted the connection. Not a failure. |
| `ok: true` with `replay` reporting a non-2xx `response.statusCode` | The replay worked and the target answered with that status. A 4xx or 5xx from the target is a result, not a CLI error; only transport failures raise `REQABLE_API_ERROR`. |
| A `curl` command from `capture curl` that fails locally | `data.curl` uses Windows cmd line continuations. On a POSIX shell use `data.curlSingleLine` instead. |

## Timeouts

Request timeouts are separate from exit codes: a call that exceeds its timeout reports exit 4 with a message naming the timeout, because the transport failed rather than Reqable answering. Raise `--timeout <ms>` for `replay` when a target is slow. There is no global timeout flag; the API calls use a fixed, generous budget of their own.
