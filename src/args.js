/**
 * Minimal, spec-driven argument parser.
 *
 * Written by hand rather than pulled from npm because the CLI must run with
 * zero install footprint: an agent may invoke it on a locked-down machine where
 * `npm install` is not an option.
 *
 * Supported forms: `--flag value`, `--flag=value`, `--bool`, `--list a --list b`
 * and `--list a,b`. Parsing is strict: an unknown flag is a usage error, never
 * silently ignored.
 */

import { usageError } from './errors.js';

/**
 * @param {string[]} argv
 * @param {object} spec
 * @param {Record<string, {type?: 'string'|'number'|'boolean'|'list', alias?: string, description: string}>} spec.flags
 * @param {Array<{name: string, required?: boolean, description: string}>} [spec.positionals]
 * @param {number} [spec.minPositionals]
 * @param {number} [spec.maxPositionals]
 */
export function parseArgs(argv, spec) {
  const flagDefs = spec.flags ?? {};
  const aliasToName = new Map();
  for (const [name, def] of Object.entries(flagDefs)) {
    if (def.alias) aliasToName.set(def.alias, name);
  }

  const values = {};
  const positionals = [];
  let rest = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (rest) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      rest = true;
      continue;
    }

    let name;
    let inlineValue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    } else if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const alias = token.slice(1);
      name = aliasToName.get(alias);
      if (!name) throw usageError(`Unknown option: ${token}`);
    } else {
      positionals.push(token);
      continue;
    }

    if (name === 'help') {
      values.help = true;
      continue;
    }

    const def = flagDefs[name];
    if (!def) throw usageError(`Unknown option: --${name}`);

    const type = def.type ?? 'string';
    if (type === 'boolean') {
      values[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      raw = argv[i + 1];
      if (raw === undefined || (raw.startsWith('--') && raw.length > 2)) {
        throw usageError(`Option --${name} requires a value`);
      }
      i += 1;
    }

    if (type === 'number') {
      const num = Number(raw);
      if (!Number.isFinite(num)) throw usageError(`Option --${name} expects a number, got "${raw}"`);
      values[name] = num;
    } else if (type === 'list') {
      const parts = String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      values[name] = [...(values[name] ?? []), ...parts];
    } else {
      values[name] = raw;
    }
  }

  if (spec.positionals) {
    const required = spec.positionals.filter((p) => p.required).length;
    if (positionals.length < required) {
      const names = spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(' ');
      throw usageError(`Missing required argument. Usage: ${names}`);
    }
  }
  if (spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) {
    throw usageError(`Too many arguments: expected at most ${spec.maxPositionals}, got ${positionals.length}`);
  }

  return { values, positionals };
}

/**
 * Transport flags every command accepts (see the `rootFlags` map in cli.js).
 * renderHelp appends any entry a command's help forgot to document, so the
 * rendered help can never drift from the flags the parser actually accepts.
 */
const AUTO_TRANSPORT_HELP = [
  { name: '--api-host <host>', description: 'Reqable API host. [default: 127.0.0.1]' },
  { name: '--api-port <port>', description: "Reqable API port. Defaults to Reqable's configured proxy port, else 9000." },
];

/**
 * Render help text for a spec. `--help` is the CLI's own interface
 * documentation, so this output is a deliverable, not an afterthought.
 *
 * @param {object} args
 * @param {string} args.command
 * @param {string} args.summary
 * @param {Array<{name: string, description: string, default?: string, values?: string[]}>} args.options
 * @param {string[]} [args.examples]
 * @param {string} [args.notes]
 */
export function renderHelp({ command, summary, options, examples, notes }) {
  const lines = [];
  lines.push(`reqable-cli ${command} — ${summary}`);
  lines.push('');

  // Every command also accepts the transport flags. Append whichever ones this
  // command's help forgot, so the rendered help always matches the parser.
  const documented = [...(options ?? [])];
  for (const entry of AUTO_TRANSPORT_HELP) {
    const flag = entry.name.split(' ')[0];
    if (!documented.some((opt) => opt.name.startsWith(flag))) documented.push(entry);
  }

  if (documented.length) {
    lines.push('Options:');
    for (const opt of documented) {
      const values = opt.values ? ` (${opt.values.join('|')})` : '';
      const def = opt.default !== undefined ? ` [default: ${opt.default}]` : '';
      lines.push(`  ${opt.name}${values}${def}`);
      lines.push(`      ${opt.description}`);
    }
    lines.push('');
  }
  if (notes) {
    lines.push(notes.trimEnd());
    lines.push('');
  }
  if (examples?.length) {
    lines.push('Examples:');
    for (const ex of examples) lines.push(`  ${ex}`);
    lines.push('');
  }
  return lines.join('\n');
}
