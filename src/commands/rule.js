/**
 * `reqable-cli rule …` — breakpoints, rewrites and scripts.
 *
 * Three rule types share one shape of API (Reqable's own design):
 *   list     GET  /capture/<type>/list
 *   feature  POST /capture/<type>/on|off
 *   toggle   POST /capture/<type>/enable|disable   body { ids: [], enabled }
 *   create   POST /capture/<type>/create           body = caller's payload
 *
 * This command deliberately does NOT re-encode each rule type's field surface.
 * `rule set --file` forwards the JSON you give it to Reqable verbatim, the same
 * way the MCP tools do, so the field vocabulary stays Reqable's and cannot drift
 * out of sync with a future Reqable release. The fields you can use are listed
 * in README.md under "Rule payloads".
 */

import fs from 'node:fs';

import { usageError } from '../errors.js';
import { RULE_TYPES } from '../reqable.js';

const transportFlags = {
  'api-host': { type: 'string', description: 'Reqable API host.' },
  'api-port': { type: 'number', description: 'Reqable API port.' },
  pretty: { type: 'boolean', description: 'Indent the JSON output.' },
};

/** Reqable returns a bare JSON array for rule lists; tolerate both shapes. */
function normalizeList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload === null || payload === undefined) return [];
  return [payload];
}

async function listCommand(api, values) {
  const requested = values.type ?? 'all';
  if (requested !== 'all' && !RULE_TYPES.includes(requested)) {
    throw usageError('--type expects one of: all, breakpoint, rewrite, script');
  }
  const types = requested === 'all' ? RULE_TYPES : [requested];

  const rules = {};
  const counts = {};
  for (const type of types) {
    const payload = await api.listRules(type);
    const items = normalizeList(payload);
    rules[type] = items;
    counts[type] = items.length;
  }

  return {
    data: {
      types,
      counts,
      totalRules: Object.values(counts).reduce((a, b) => a + b, 0),
      rules,
    },
  };
}

const listHelp = {
  command: 'rule list',
  summary: 'list breakpoints, rewrite rules and scripts configured in Reqable',
  options: [
    { name: '--type <t>', description: 'Which rule family to list.', values: ['all', 'breakpoint', 'rewrite', 'script'], default: 'all' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `Returns Reqable's own rule objects unchanged, grouped by type under data.rules.
Read-only: listing rules never changes them.`,
  examples: ['reqable-cli rule list', 'reqable-cli rule list --type rewrite --pretty'],
};

async function setCommand(api, values) {
  const type = values.type;
  if (!type || !RULE_TYPES.includes(type)) {
    throw usageError(`--type is required and must be one of: ${RULE_TYPES.join(', ')}`);
  }

  const actions = [
    values.file !== undefined,
    values.payload !== undefined,
    values.enable?.length > 0,
    values.disable?.length > 0,
    values.feature !== undefined,
  ].filter(Boolean).length;

  if (actions === 0) {
    throw usageError(
      'Nothing to do. Pass one of --feature on|off, --enable <id>, --disable <id>, --file <json> or --payload <json>.',
    );
  }
  if (actions > 1) {
    throw usageError('--feature, --enable, --disable, --file and --payload are mutually exclusive; pass exactly one.');
  }

  if (values.feature !== undefined) {
    const enabled = values.feature === 'on';
    if (!enabled && values.feature !== 'off') {
      throw usageError('--feature expects "on" or "off".');
    }
    if (!values['dry-run']) await api.setRuleFeatureEnabled(type, enabled);
    return { data: { type, action: 'feature', enabled, applied: !values['dry-run'] } };
  }

  if (values.enable?.length) {
    if (!values['dry-run']) await api.setRulesEnabled(type, values.enable, true);
    return { data: { type, action: 'enable', ids: values.enable, applied: !values['dry-run'] } };
  }

  if (values.disable?.length) {
    if (!values['dry-run']) await api.setRulesEnabled(type, values.disable, false);
    return { data: { type, action: 'disable', ids: values.disable, applied: !values['dry-run'] } };
  }

  const payload = readPayload(values);
  if (values['dry-run']) {
    return { data: { type, action: 'create', applied: false, payload } };
  }
  const created = await api.createRule(type, payload);
  return { data: { type, action: 'create', applied: true, created } };
}

const setHelp = {
  command: 'rule set',
  summary: 'turn rules on or off, or create a new breakpoint, rewrite or script',
  options: [
    { name: '--type <t>', description: 'Which rule family to act on. Required.', values: ['breakpoint', 'rewrite', 'script'] },
    { name: '--feature <on|off>', description: 'Toggle the whole feature for this rule family.' },
    { name: '--enable <id>', description: 'Enable one rule by id. Repeatable.' },
    { name: '--disable <id>', description: 'Disable one rule by id. Repeatable.' },
    { name: '--file <file>', description: 'Create a rule from a JSON file.' },
    { name: '--payload <json>', description: 'Create a rule from an inline JSON payload.' },
    { name: '--dry-run', description: 'Report what would be sent without sending it.' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `Write command: it changes Reqable's live interception behaviour. Preflight with
--dry-run when in doubt.

The create payload is forwarded to Reqable verbatim — the field names are
Reqable's own, listed in README.md under "Rule payloads". Start from
"reqable-cli rule list --type <t>" to see the shape of existing rules.`,
  examples: [
    'reqable-cli rule list --type rewrite',
    'reqable-cli rule set --type rewrite --disable abc123',
    'reqable-cli rule set --type breakpoint --file breakpoint.json --dry-run',
  ],
};

function readPayload(values) {
  const raw = values.file !== undefined ? readFile(values.file) : values.payload;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw usageError(`The rule payload is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError('The rule payload must be a JSON object.');
  }
  return parsed;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw usageError(`Cannot read rule payload file "${file}": ${error.message}`);
  }
}

export const ruleSubcommands = {
  list: { run: listCommand, help: listHelp, flags: { ...transportFlags, type: { type: 'string' } }, maxPositionals: 0 },
  set: {
    run: setCommand,
    help: setHelp,
    flags: {
      ...transportFlags,
      type: { type: 'string' },
      feature: { type: 'string' },
      enable: { type: 'list' },
      disable: { type: 'list' },
      file: { type: 'string' },
      payload: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    maxPositionals: 0,
  },
};

export const ruleHelp = {
  command: 'rule',
  summary: 'inspect and change Reqable breakpoints, rewrites and scripts',
  options: [
    { name: '<subcommand>', description: 'list or set', values: ['list', 'set'] },
  ],
  notes: `Run "reqable-cli rule <subcommand> --help" for the flags.

Note the trust boundary: a rewrite rule or breakpoint changes what a client sees
for every matching request, on every application that goes through Reqable --
not only the traffic you were analysing. Create rules only for targets you are
authorised to modify.`,
  examples: ['reqable-cli rule list', 'reqable-cli rule set --type script --file script.json'],
};
