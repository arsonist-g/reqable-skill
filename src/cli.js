/**
 * Command dispatcher.
 *
 * Command surface, deliberately capped at ten entry points:
 *
 *   status            is Reqable usable, and with which capture features on
 *   capture list      which requests were captured
 *   capture get       one record in full
 *   capture curl      one record as a reproducible curl command
 *   capture export    records to a HAR 1.2 or JSON file
 *   capture clear     discard the session
 *   capture on|off    start and stop capture
 *   replay            re-send a captured request
 *   rule list         breakpoints, rewrites, scripts
 *   rule set          enable, disable or create them
 *
 * `--help` is the interface documentation: every command and subcommand answers
 * it on stdout and exits 0.
 */

import { parseArgs, renderHelp } from './args.js';
import { captureHelp, captureSubcommands } from './commands/capture.js';
import { replayCommand, replayHelp } from './commands/replay.js';
import { ruleHelp, ruleSubcommands } from './commands/rule.js';
import { skillHelp, skillSubcommands } from './commands/skill.js';
import { statusCommand, statusHelp } from './commands/status.js';
import { EXIT, usageError } from './errors.js';
import { print, printHelp, run } from './output.js';
import { ReqableApi } from './reqable.js';

const VERSION = '1.0.3';

/** Flags accepted by every command. */
// Exported for the parity test: it rebuilds each command's spec exactly as the
// dispatcher does and compares it with the rendered help.
export const rootFlags = {
  'api-host': { type: 'string', description: 'Reqable API host.' },
  'api-port': { type: 'number', description: "Reqable API port. Defaults to Reqable's configured proxy port, else 9000." },
  pretty: { type: 'boolean', description: 'Indent the JSON output.' },
  json: { type: 'boolean', description: 'Machine-readable JSON output. On by default; accepted for explicitness.' },
  help: { type: 'boolean', description: 'Show help and exit 0.' },
};

const rootHelpText = `
reqable-cli — drive Reqable's captured traffic from a shell, without an MCP server

Usage:
  reqable-cli <command> [options]

Commands:
  status                            Is Reqable reachable; which capture features are on
  capture list | get | curl         Read captured records
  capture export | clear            Move records out, or discard them
  capture on | off                  Start and stop capture
  replay <id>                       Re-send a captured request
  rule list | set                   Inspect and change breakpoints, rewrites, scripts

Setup (a one-time action, not part of capture work):
  skill install                     Write the agent-facing skill into a skills directory

Global options:
  --api-host <host>  Reqable API host. [default: 127.0.0.1]
  --api-port <port>  Reqable API port. [default: Reqable's proxyPort, else 9000]
  --json           Machine-readable JSON output (default).
  --pretty         Indent the JSON output for reading.
  --help           Show help for any command. Exits 0.
  --version        Print the version.

Output contract:
  Every command writes exactly one JSON object to stdout:
    success  {"ok":true,"command":"...","data":{...},"meta":{...}}
    failure  {"ok":false,"command":"...","error":{"code":"...","message":"...","exitCode":N}}
  Nothing else is written to stdout; diagnostics go to stderr under
  REQABLE_CLI_DEBUG=1 only.

Exit codes:
  0  success                4  Reqable answered with an error
  1  internal error         5  not found (no such record, rule or file)
  2  usage error            6  confirmation required (pass --yes)
  3  Reqable not reachable

Requirements:
  Reqable desktop must be running. Its local API is served by the app process on
  the same port as its capture proxy, so there is nothing to talk to while
  Reqable is closed.

More:
  reqable-cli <command> --help    Per-command flags, output shape and examples
  README.md                       Record schema, endpoint table, rule payloads
`.trim();

export async function main(argv) {
  const [first, second, ...rest] = argv;

  if (first === undefined) return printHelp(rootHelpText);
  if (first === '--help' || first === '-h' || first === 'help') {
    if (second && !second.startsWith('-')) return printHelp(helpFor([second, ...rest]));
    return printHelp(rootHelpText);
  }
  if (first === '--version' || first === 'version') {
    print({ name: 'reqable-cli', version: VERSION }, {});
    return EXIT.OK;
  }

  switch (first) {
    case 'status':
      return await runLeaf('status', statusCommand, statusHelp, rootFlags, [], [second, ...rest]);
    case 'capture':
      return await runBranch({
        branch: 'capture',
        branchHelp: captureHelp,
        subcommands: captureSubcommands,
        args: [second, ...rest],
      });
    case 'rule':
      return await runBranch({
        branch: 'rule',
        branchHelp: ruleHelp,
        subcommands: ruleSubcommands,
        args: [second, ...rest],
      });
    case 'skill':
      return await runBranch({
        branch: 'skill',
        baseFlags: {},
        branchHelp: skillHelp,
        subcommands: skillSubcommands,
        args: [second, ...rest],
      });
    case 'replay':
      return await runLeaf(
        'replay',
        (api, values, positionals) => replayCommand(api, values, positionals),
        replayHelp,
        { ...rootFlags, ...replayFlags() },
        [{ name: 'id', required: true, description: 'Numeric capture record id.' }],
        [second, ...rest],
        { maxPositionals: 1 },
      );
    default:
      return run(first, {}, async () => {
        throw usageError(`Unknown command: ${first}. Run "reqable-cli --help" for the command list.`);
      });
  }
}

/**
 * Run a command that has no subcommands.
 */
async function runLeaf(command, body, help, flags, positionals, argv, extra = {}) {
  const spec = { flags, positionals, maxPositionals: extra.maxPositionals ?? positionals.length };
  let parsed;
  try {
    parsed = parseArgs(argv.filter((a) => a !== undefined), spec);
  } catch (error) {
    if (error.code === 'USAGE' && argv.includes('--help')) return printHelp(renderHelp(help));
    return run(command, {}, async () => {
      throw error;
    });
  }

  if (parsed.values.help) return printHelp(renderHelp(help));

  // Constructed inside the body, not before it: the constructor validates
  // --api-host and --api-port and throws CliError, and `run` is what turns a
  // CliError into the JSON envelope. Building it out here let a usage error
  // escape as a raw stack trace with an empty stdout and exit 1.
  return run(command, parsed.values, () => {
    const api = new ReqableApi({ host: parsed.values['api-host'], port: parsed.values['api-port'] });
    return body(api, parsed.values, parsed.positionals);
  });
}

/**
 * Run a branch command such as `capture` or `rule`, resolving its subcommand.
 */
async function runBranch({ branch, branchHelp, subcommands, args, baseFlags = rootFlags }) {
  const [rawSub, ...rest] = args;

  if (rawSub === undefined || rawSub === '--help' || rawSub === '-h') {
    return printHelp(renderHelp(branchHelp));
  }

  const sub = Object.hasOwn(subcommands, rawSub) ? subcommands[rawSub] : undefined;
  if (!sub) {
    return run(`${branch} ${rawSub}`, {}, async () => {
      throw usageError(
        `Unknown ${branch} subcommand: ${rawSub}. Expected one of: ${Object.keys(subcommands).join(', ')}.`,
      );
    });
  }

  const command = `${branch} ${rawSub}`;
  const spec = {
    flags: { ...baseFlags, ...sub.flags },
    positionals: sub.positionals,
    maxPositionals: sub.maxPositionals ?? sub.positionals?.length ?? 0,
  };

  let parsed;
  try {
    parsed = parseArgs(rest, spec);
  } catch (error) {
    if (error.code === 'USAGE' && rest.includes('--help')) return printHelp(renderHelp(sub.help));
    return run(command, {}, async () => {
      throw error;
    });
  }

  if (parsed.values.help) return printHelp(renderHelp(sub.help));

  // Same reason as runLeaf: validation errors must land inside `run`'s envelope.
  return run(command, parsed.values, () => {
    const api = new ReqableApi({ host: parsed.values['api-host'], port: parsed.values['api-port'] });
    return sub.run(api, parsed.values, parsed.positionals);
  });
}

/** Flags specific to `replay`, kept next to its help definition. */
export function replayFlags() {
  return {
    via: { type: 'string' },
    proxy: { type: 'string' },
    header: { type: 'list' },
    method: { type: 'string' },
    url: { type: 'string' },
    body: { type: 'string' },
    timeout: { type: 'number' },
    'max-body': { type: 'number' },
    full: { type: 'boolean' },
    insecure: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  };
}

function helpFor(parts) {
  const [branch, sub] = parts;
  // Object.hasOwn, for the same reason as runBranch: a name such as
  // `constructor` must not resolve through Object.prototype. A helper that
  // threw here would leave stdout without its JSON envelope.
  const pick = (map, branchHelp) =>
    sub && Object.hasOwn(map, sub) ? renderHelp(map[sub].help) : renderHelp(branchHelp);

  if (branch === 'capture') return pick(captureSubcommands, captureHelp);
  if (branch === 'rule') return pick(ruleSubcommands, ruleHelp);
  if (branch === 'skill') return pick(skillSubcommands, skillHelp);
  if (branch === 'status') return renderHelp(statusHelp);
  if (branch === 'replay') return renderHelp(replayHelp);
  return rootHelpText;
}
