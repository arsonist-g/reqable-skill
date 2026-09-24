/**
 * Output contract.
 *
 * Data-producing commands print exactly one JSON object on stdout and nothing
 * else; progress and diagnostics never go to stdout, so stdout stays parseable
 * by any JSON consumer. The envelope is stable:
 *
 *   success  { "ok": true,  "command": "...", "data": {...}, "meta": {...} }
 *   failure  { "ok": false, "command": "...", "error": {...}, "meta": {...} }
 *
 * Failures still print a JSON object and set the exit code from errors.js.
 */

import { CliError, EXIT } from './errors.js';

/**
 * @param {object} args
 * @param {string} args.command    canonical command path, e.g. "capture list"
 * @param {*} args.data            command payload
 * @param {object} [args.meta]     transport-level context (host, port, timings)
 */
export function ok({ command, data, meta }) {
  return { envelope: { ok: true, command, data: data === undefined ? null : data, meta: meta ?? {} } };
}

/**
 * Run a command body, print its envelope, and return the process exit code.
 * Catches everything: a bug in a command must not print a stack trace on stdout.
 *
 * @param {string} command canonical command path
 * @param {{json?: boolean, pretty?: boolean}} flags output flags
 * @param {() => Promise<{data: *, meta?: object}>} body
 * @returns {Promise<number>} process exit code
 */
export async function run(command, flags, body) {
  const startedAt = Date.now();
  let envelope;
  let exitCode = EXIT.OK;

  try {
    const { data, meta } = await body();
    envelope = ok({ command, data, meta: { ...(meta ?? {}), durationMs: Date.now() - startedAt } }).envelope;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError('INTERNAL_ERROR', error?.message ?? String(error), {
            exitCode: EXIT.INTERNAL,
            details: { name: error?.name },
            cause: error,
          });

    exitCode = cliError.exitCode;
    envelope = {
      ok: false,
      command,
      error: {
        code: cliError.code,
        message: cliError.message,
        exitCode: cliError.exitCode,
        ...(cliError.details ? { details: cliError.details } : {}),
      },
      meta: { durationMs: Date.now() - startedAt },
    };

    if (process.env.REQABLE_CLI_DEBUG) {
      process.stderr.write(`${cliError.stack}\n`);
      if (cliError.cause?.stack) process.stderr.write(`caused by: ${cliError.cause.stack}\n`);
    }
  }

  print(envelope, flags);
  return exitCode;
}

/** Write a value to stdout as JSON. Compact by default, indented with --pretty. */
export function print(value, flags = {}) {
  const text = flags.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(`${text}\n`);
}

/**
 * Render help text. Help goes to stdout and always exits 0: it is the interface
 * documentation, and callers must be able to read it without special-casing.
 */
export function printHelp(text) {
  process.stdout.write(`${text.trimEnd()}\n`);
  return EXIT.OK;
}
