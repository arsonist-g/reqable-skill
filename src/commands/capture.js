/**
 * `reqable-cli capture …` — everything that reads or shapes captured traffic.
 *
 * Subcommands: list, get, curl, export, clear, on, off.
 *
 * Design note: Reqable's `/capture/live/filter` returns record IDs only, never
 * record bodies. So "show me the last few requests with their status codes" is
 * two API calls deep by construction: filter for IDs, then get each record. The
 * `list` subcommand hides that, and `--ids-only` exposes it.
 */

import fs from 'node:fs';

import { confirmationError, usageError } from '../errors.js';
import { buildFilters, describeFilters, filterFlags } from '../filters.js';
import { curlToSingleLine, harDocument, summarize } from '../records.js';

/** Flags every capture subcommand accepts. */
const transportFlags = {
  'api-host': { type: 'string', description: 'Reqable API host.' },
  'api-port': { type: 'number', description: 'Reqable API port.' },
  pretty: { type: 'boolean', description: 'Indent the JSON output.' },
};

const selectionFlags = {
  limit: { type: 'number', description: 'Maximum records to return. 0 means no limit.' },
  sort: { type: 'string', description: 'Order of returned records.', values: ['newest', 'oldest'] },
  ...filterFlags,
};

const DEFAULT_LIMIT = 50;

/** Resolve IDs for the requested filters, sorted and truncated. */
async function selectIds(api, values) {
  const filters = buildFilters(values);
  const ids = await api.filterRecords(filters);
  const sort = values.sort ?? 'newest';
  const sorted = [...ids].sort((a, b) => (sort === 'oldest' ? a - b : b - a));
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  const limited = limit > 0 ? sorted.slice(0, limit) : sorted;
  return { filters, ids: limited, total: sorted.length };
}

/** Fetch full records for a list of IDs, in order. */
async function fetchRecords(api, ids) {
  const records = [];
  for (const id of ids) {
    try {
      records.push(await api.getRecord(id));
    } catch (error) {
      // A record can disappear between filter and get if capture is cleared
      // concurrently. Skipping it keeps a list call useful instead of fatal.
      if (error?.code === 'NOT_FOUND') continue;
      throw error;
    }
  }
  return records;
}

/** Explain an empty result, since "nothing captured" and "capture off" differ. */
async function emptyHint(api) {
  try {
    const status = await api.captureStatus();
    if (status?.status !== 'active') {
      return `No records matched, and live capture is ${status?.status ?? 'unknown'}. Run "reqable-cli capture on" and send traffic through the proxy first.`;
    }
  } catch {
    return undefined;
  }
  return 'No records matched the given filters.';
}

// -- capture list -----------------------------------------------------------

async function listCommand(api, values) {
  const { filters, ids, total } = await selectIds(api, values);
  const data = {
    filters,
    filterSummary: describeFilters(filters),
    totalMatched: total,
    returned: ids.length,
    ids,
    items: [],
    mode: values['ids-only'] ? 'ids' : 'detail',
  };

  if (values['ids-only']) {
    return { data };
  }

  const records = await fetchRecords(api, ids);
  data.items = records.map(summarize);

  if (data.items.length === 0) {
    const hint = await emptyHint(api);
    if (hint) data.hint = hint;
  }

  return { data };
}

const listHelp = {
  command: 'capture list',
  summary: 'list captured requests, optionally filtered',
  options: [
    { name: '--host <h>', description: 'Filter records by request host. This is a record filter; the API host flag is --api-host.' },
    { name: '--method <m>', description: 'Match by HTTP method, e.g. GET or POST.' },
    { name: '--code <c>', description: 'Match by response status code.' },
    { name: '--url <u>', description: 'Match by exact request URL.' },
    { name: '--keyword <k>', description: 'Match a keyword anywhere in URL, headers or bodies.' },
    { name: '--regex', description: 'Treat --keyword as a regular expression.' },
    { name: '--case-sensitive', description: 'Make --keyword matching case-sensitive.' },
    { name: '--ip <ip>', description: 'Match by remote IP address.' },
    { name: '--app <name>', description: 'Match by client application name.' },
    { name: '--pid <n>', description: 'Match by client application process id.' },
    { name: '--limit <n>', description: 'Maximum records returned; 0 means no limit.', default: String(DEFAULT_LIMIT) },
    { name: '--sort <s>', description: 'Record order.', values: ['newest', 'oldest'], default: 'newest' },
    { name: '--ids-only', description: 'Return IDs without fetching each record. Much cheaper; no method/status fields.' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `Multiple filters are combined with logical AND.
data.items[].id is what every other command takes. The ID space is per capture
session and is reused after a clear.`,
  examples: [
    'reqable-cli capture list --limit 20',
    'reqable-cli capture list --host api.example.com --method POST',
    'reqable-cli capture list --code 500,502 --limit 5 --pretty',
  ],
};

// -- capture get ------------------------------------------------------------

async function getCommand(api, values, positionals) {
  const id = parseId(positionals[0]);
  const record = await api.getRecord(id);

  const data = { id, record };

  if (values.out) {
    fs.writeFileSync(values.out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    data.savedRecordTo = values.out;
  }

  if (values['body-out']) {
    const body = record?.response?.body;
    if (!body || typeof body.text !== 'string') {
      throw usageError('This record has no response body to write out.');
    }
    if (body.encoding === 'base64') {
      fs.writeFileSync(values['body-out'], Buffer.from(body.text, 'base64'));
    } else if (body.encoding === 'file') {
      fs.copyFileSync(body.text, values['body-out']);
    } else {
      fs.writeFileSync(values['body-out'], body.text, 'utf8');
    }
    data.savedResponseBodyTo = values['body-out'];
  }

  return { data };
}

const getHelp = {
  command: 'capture get <id>',
  summary: 'fetch one captured record with its full request, response and bodies',
  options: [
    { name: '--out <file>', description: 'Also write the raw record JSON to this file.' },
    { name: '--body-out <file>', description: 'Also write the response body to this file, decoded to raw bytes.' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `The record shape is documented in README.md: protocol, id, uid, url,
connection, application, request, response (nullable), messages.

Body payloads are { text, mime?, encoding } where encoding is utf8, base64 or
file. For encoding=file, text is a path on this machine that holds the body.`,
  examples: ['reqable-cli capture get 12', 'reqable-cli capture get 12 --body-out body.bin'],
};

// -- capture curl -----------------------------------------------------------

async function curlCommand(api, values, positionals) {
  const id = parseId(positionals[0]);
  const raw = await api.generateCurl(id);
  const curl = typeof raw === 'string' ? raw : (raw?.curl ?? JSON.stringify(raw));
  return { data: { id, curl, curlSingleLine: curlToSingleLine(curl) } };
}

const curlHelp = {
  command: 'capture curl <id>',
  summary: 'get a reproducible cURL command for a captured record',
  options: [
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `Reqable emits the command with Windows cmd line continuations. data.curl is
Reqable's original text; data.curlSingleLine is the same command joined into one
POSIX-safe line.`,
  examples: ['reqable-cli capture curl 12', 'reqable-cli capture curl 12 --pretty'],
};

// -- capture export ---------------------------------------------------------

async function exportCommand(api, values) {
  const format = (values.format ?? 'har').toLowerCase();
  if (format !== 'har' && format !== 'json') {
    throw usageError('--format expects "har" or "json".');
  }
  if (!values.out) {
    throw usageError('--out is required: name the file to write, or use --out - for stdout.');
  }

  const { filters, ids, total } = await selectIds(api, values);
  const records = await fetchRecords(api, ids);
  const document = format === 'har' ? harDocument(records) : { records };

  const text = `${JSON.stringify(document, null, 2)}\n`;

  if (values.out === '-') {
    process.stdout.write(text);
    return { data: { format, entries: records.length, totalMatched: total, filters, writtenTo: 'stdout' } };
  }

  fs.writeFileSync(values.out, text, 'utf8');
  const bytes = fs.statSync(values.out).size;

  return {
    data: {
      format,
      entries: records.length,
      totalMatched: total,
      filters,
      writtenTo: values.out,
      bytes,
    },
  };
}

const exportHelp = {
  command: 'capture export',
  summary: 'export captured traffic to a HAR 1.2 or raw JSON file',
  options: [
    { name: '--out <file>', description: 'Destination file. Required. Use - to write to stdout.' },
    { name: '--format <f>', description: 'Output format.', values: ['har', 'json'], default: 'har' },
    { name: '--limit <n>', description: 'Maximum records to export; 0 means no limit.', default: String(DEFAULT_LIMIT) },
    { name: '--sort <s>', description: 'Record order.', values: ['newest', 'oldest'], default: 'newest' },
    { name: '--host <h>', description: 'Filter records by request host. This is a record filter; the API host flag is --api-host.' },
    { name: '--method <m>', description: 'Filter by HTTP method.' },
    { name: '--code <c>', description: 'Filter by response status code.' },
    { name: '--url <u>', description: 'Filter by exact request URL.' },
    { name: '--keyword <k>', description: 'Filter by keyword.' },
    { name: '--regex', description: 'Treat --keyword as a regular expression.' },
    { name: '--case-sensitive', description: 'Make --keyword matching case-sensitive.' },
    { name: '--ip <ip>', description: 'Filter by remote IP address.' },
    { name: '--app <name>', description: 'Filter by client application name.' },
    { name: '--pid <n>', description: 'Filter by client application process id.' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `The filter flags choose what goes into the file, and --limit truncates without
saying so: pass --limit 0 when the file must hold every match.

HAR timings are reported as -1 in every phase: Reqable's local API exposes no
per-phase timing for a live record, and -1 is HAR 1.2's value for "unavailable".
Bodies are inlined; binary bodies use HAR's base64 content encoding.`,
  examples: [
    'reqable-cli capture export --out session.har',
    'reqable-cli capture export --format json --out session.json --limit 0',
  ],
};

// -- capture clear / on / off ----------------------------------------------

async function clearCommand(api, values) {
  if (!values.yes) {
    throw confirmationError(
      'capture clear destroys the current capture session. Re-run with --yes to confirm.',
      { command: 'capture clear' },
    );
  }
  await api.clearRecords();
  return { data: { cleared: true } };
}

const clearHelp = {
  command: 'capture clear',
  summary: 'discard all retained capture records',
  options: [
    { name: '--yes', description: 'Required. Acknowledges that the capture session will be discarded.' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: 'Destructive and not reversible from the CLI. Record IDs restart after a clear.',
  examples: ['reqable-cli capture clear --yes'],
};

function powerCommand(enabled) {
  return async (api) => {
    await (enabled ? api.captureOn() : api.captureOff());
    const status = await api.captureStatus();
    return { data: { requested: enabled ? 'on' : 'off', status: status?.status ?? null } };
  };
}

const onHelp = {
  command: 'capture on',
  summary: 'start live capture so that proxied traffic is recorded',
  options: [
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `Starting capture does not route any traffic: point a client at Reqable's proxy
explicitly (HTTP_PROXY / --proxy) or accept the system-proxy setting you already
have. This command never changes your system proxy.`,
  examples: ['reqable-cli capture on', 'reqable-cli capture off'],
};

// -- wiring -----------------------------------------------------------------

export const captureSubcommands = {
  list: { run: listCommand, help: listHelp, flags: { ...transportFlags, ...selectionFlags, 'ids-only': { type: 'boolean', description: 'IDs only.' } }, maxPositionals: 0 },
  get: {
    run: getCommand,
    help: getHelp,
    flags: { ...transportFlags, out: { type: 'string' }, 'body-out': { type: 'string' } },
    positionals: [{ name: 'id', required: true, description: 'Numeric capture record id.' }],
    maxPositionals: 1,
  },
  curl: {
    run: curlCommand,
    help: curlHelp,
    flags: { ...transportFlags },
    positionals: [{ name: 'id', required: true, description: 'Numeric capture record id.' }],
    maxPositionals: 1,
  },
  export: { run: exportCommand, help: exportHelp, flags: { ...transportFlags, ...selectionFlags, out: { type: 'string' }, format: { type: 'string' } }, maxPositionals: 0 },
  clear: { run: clearCommand, help: clearHelp, flags: { ...transportFlags, yes: { type: 'boolean' } }, maxPositionals: 0 },
  on: { run: powerCommand(true), help: onHelp, flags: { ...transportFlags }, maxPositionals: 0 },
  off: { run: powerCommand(false), help: onHelp, flags: { ...transportFlags }, maxPositionals: 0 },
};

export const captureHelp = {
  command: 'capture',
  summary: 'read, filter, export and control captured traffic',
  options: [
    { name: '<subcommand>', description: 'One of: list, get, curl, export, clear, on, off', values: ['list', 'get', 'curl', 'export', 'clear', 'on', 'off'] },
  ],
  notes: `Run "reqable-cli capture <subcommand> --help" for the flags of each one.

Records only exist while Reqable's capture is running, so the usual order is:
  reqable-cli capture on
  <send traffic through Reqable's proxy>
  reqable-cli capture list`,
  examples: ['reqable-cli capture list --limit 10', 'reqable-cli capture get 3'],
};

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) {
    throw usageError(`Expected a numeric capture record id, got "${raw}". Use "reqable-cli capture list" to see valid ids.`);
  }
  return id;
}
