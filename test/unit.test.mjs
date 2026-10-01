/**
 * Unit checks that need no Reqable install.
 *
 * These exist because the things they cover are the ones a running instance
 * cannot reveal: which port the CLI will pick when Reqable's config says
 * something unusual, what it does with garbage input, and whether every flag the
 * help advertises is a flag the parser actually accepts. That last one is the
 * drift this project has already been bitten by once.
 *
 * `npm test` runs this file; it touches no network and no Reqable state.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseArgs, renderHelp } from '../src/args.js';
import { captureSubcommands } from '../src/commands/capture.js';
import { replayHelp } from '../src/commands/replay.js';
import { ruleSubcommands } from '../src/commands/rule.js';
import { defaultSkillsDir, skillSubcommands } from '../src/commands/skill.js';
import { statusHelp } from '../src/commands/status.js';
import { replayFlags, rootFlags } from '../src/cli.js';
import {
  CliError,
  EXIT,
  apiError,
  confirmationError,
  notFoundError,
  unreachableError,
  usageError,
} from '../src/errors.js';
import { buildFilters } from '../src/filters.js';
import { bodyByteLength, curlToSingleLine, harDocument, harEntry, summarize } from '../src/records.js';
import {
  DEFAULT_PORT,
  SUPPORTED_REQABLE,
  VERIFIED_REQABLE,
  detectReqableVersion,
  resolvePort,
  versionLine,
  bareHost,
  formatHostPort,
} from '../src/reqable.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqable-cli-unit-'));
const write = (name, content) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return file;
};

// ----------------------------------------------------------- port discovery

test('resolvePort prefers an explicit flag over the config file', () => {
  const config = write('cfg-flag.json', JSON.stringify({ proxyPort: 4321 }));
  assert.deepEqual(resolvePort(1234, config), {
    port: 1234,
    source: 'flag',
    configPath: config,
    reason: 'explicit-flag',
  });
});

test("resolvePort follows Reqable's configured port, not a hard-coded 9000", () => {
  const config = write('cfg-port.json', JSON.stringify({ proxyPort: 4321, autoCapture: false }));
  const resolved = resolvePort(undefined, config);
  assert.equal(resolved.port, 4321);
  assert.equal(resolved.source, 'reqable-config');
  assert.equal(resolved.reason, 'from-config');
});

test('resolvePort falls back to 9000 and names the real reason it could not trust the config', () => {
  const absent = path.join(tmp, 'cfg-absent.json');
  assert.deepEqual(resolvePort(undefined, absent), {
    port: DEFAULT_PORT,
    source: 'default',
    configPath: absent,
    reason: 'config-unreadable',
  });

  // Each case earns its own reason, because the reasons point at different
  // problems: an unreadable file means this CLI is looking in the wrong place,
  // while an unusable proxyPort means Reqable is on a port it did not write
  // down. Collapsing them into one message would hide which one happened.
  for (const [name, content, reason] of [
    ['cfg-broken.json', '{ not json', 'config-not-json'],
    ['cfg-no-field.json', JSON.stringify({ autoCapture: false }), 'config-has-no-proxy-port'],
    ['cfg-string.json', JSON.stringify({ proxyPort: '9000' }), 'proxy-port-not-an-integer'],
    ['cfg-float.json', JSON.stringify({ proxyPort: 9000.5 }), 'proxy-port-not-an-integer'],
    ['cfg-low.json', JSON.stringify({ proxyPort: 0 }), 'proxy-port-out-of-range'],
    ['cfg-high.json', JSON.stringify({ proxyPort: 70000 }), 'proxy-port-out-of-range'],
  ]) {
    const resolved = resolvePort(undefined, write(name, content));
    assert.equal(resolved.source, 'default', `${name} should have fallen back`);
    assert.equal(resolved.port, DEFAULT_PORT);
    assert.equal(resolved.reason, reason, `${name} should report ${reason}`);
  }
});

// ------------------------------------------------------------- app version

test('detectReqableVersion reads the preferences file, then the event log', () => {
  const prefs = write('prefs.json', JSON.stringify({ 'flutter.app_versions': ['3.1.0', '3.2.23'] }));
  const events = write('events.json', JSON.stringify({ events: [{ version: '3.0.0' }, { version: '9.9.9' }] }));

  const fromPrefs = detectReqableVersion({ prefsPath: prefs, eventsPath: events });
  assert.equal(fromPrefs.version, '3.2.23');
  assert.equal(fromPrefs.source, 'shared_preferences');

  const fromEvents = detectReqableVersion({ prefsPath: path.join(tmp, 'no-prefs.json'), eventsPath: events });
  assert.equal(fromEvents.version, '9.9.9');
  assert.equal(fromEvents.source, 'events');

  assert.equal(
    detectReqableVersion({ prefsPath: path.join(tmp, 'no-prefs.json'), eventsPath: path.join(tmp, 'no-events.json') }),
    null,
  );
});

test('versionLine reduces a version to its release line', () => {
  assert.equal(versionLine('3.2.23'), '3.2');
  assert.equal(versionLine('10.0'), '10.0');
  assert.equal(versionLine('nonsense'), null);
  assert.equal(versionLine(undefined), null);
});

test('package.json declares the same Reqable line as the code', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.reqable.supported, SUPPORTED_REQABLE);
  assert.equal(pkg.reqable.verifiedWith, VERIFIED_REQABLE);
});

// ------------------------------------------------------------------ filters

test('buildFilters maps flags onto Reqable filter objects', () => {
  const filters = buildFilters({
    host: ['a.example'],
    url: ['http://a.example/x'],
    method: ['post'],
    code: ['200', 404],
    keyword: 'needle',
    regex: true,
    'case-sensitive': true,
    ip: ['127.0.0.1'],
    app: 'curl',
    pid: 42,
  });

  assert.deepEqual(filters.find((f) => f.type === 'host'), { type: 'host', hosts: ['a.example'] });
  assert.deepEqual(filters.find((f) => f.type === 'url'), { type: 'url', urls: ['http://a.example/x'] });
  assert.deepEqual(filters.find((f) => f.type === 'method'), { type: 'method', methods: ['POST'] });
  assert.deepEqual(filters.find((f) => f.type === 'code'), { type: 'code', codes: [200, 404] });
  assert.deepEqual(filters.find((f) => f.type === 'ip'), { type: 'ip', ips: ['127.0.0.1'] });
  assert.deepEqual(filters.find((f) => f.type === 'keyword'), {
    type: 'keyword',
    pattern: 'needle',
    regex: true,
    caseSensitive: true,
  });
  assert.deepEqual(filters.find((f) => f.type === 'application'), { type: 'application', name: 'curl', pid: 42 });
});

test('buildFilters returns nothing for no flags, and rejects a non-numeric code', () => {
  assert.deepEqual(buildFilters({}), []);
  assert.throws(
    () => buildFilters({ code: ['abc'] }),
    (error) => error instanceof CliError && error.code === 'USAGE' && error.exitCode === EXIT.USAGE,
  );
});

// ------------------------------------------------------------------ records

test('bodyByteLength is exact, including base64 padding', () => {
  assert.equal(bodyByteLength({ text: 'abc', encoding: 'utf8' }), 3);
  assert.equal(bodyByteLength({ text: 'AA==', encoding: 'base64' }), 1);
  assert.equal(bodyByteLength({ text: 'AAA=', encoding: 'base64' }), 2);
  assert.equal(bodyByteLength({ text: 'AAAA', encoding: 'base64' }), 3);
  assert.equal(bodyByteLength({ text: path.join(tmp, 'absent.bin'), encoding: 'file' }), null);
  assert.equal(bodyByteLength(null), null);
});

test('harEntry reports unavailable timings and keeps a literal plus in a query', () => {
  const entry = harEntry({
    url: 'http://h/search?q=1+1&r=a%20b',
    connection: { timestamp: '2026-01-01T00:00:00.000' },
    request: { method: 'GET', headers: [{ name: 'Accept', value: '*/*' }], protocol: 'HTTP/1.1', body: null },
    response: {
      code: 200,
      status: 'OK',
      protocol: 'HTTP/1.1',
      headers: [],
      body: { text: '{"ok":true}', encoding: 'utf8', mime: 'application/json' },
    },
  });

  assert.equal(entry.time, -1);
  assert.ok(Object.values(entry.timings).every((value) => value === -1));
  assert.deepEqual(entry.request.queryString, [
    { name: 'q', value: '1+1' },
    { name: 'r', value: 'a b' },
  ]);
  assert.equal(entry.response.content.size, 11);
  assert.equal(entry.response.content.mimeType, 'application/json');
  assert.equal(entry.request.postData, undefined);
  assert.equal(entry.request.bodySize, 0);
});

test('a body whose file is gone is marked unreadable, never as an empty body', () => {
  const record = {
    url: 'http://h/download',
    connection: { timestamp: '2026-01-01T00:00:00.000' },
    request: { method: 'GET', headers: [], protocol: 'HTTP/1.1', body: null },
    response: {
      code: 200,
      status: 'OK',
      protocol: 'HTTP/1.1',
      headers: [],
      body: { text: path.join(tmp, 'gone.bin'), encoding: 'file', mime: 'application/octet-stream' },
    },
  };

  const entry = harEntry(record);
  assert.equal(entry.response.content.size, -1);
  assert.equal(entry.response.bodySize, -1);
  assert.match(entry.response.content.comment, /could not be read/);

  const built = harDocument([record]);
  assert.equal(built.unreadableBodies, 1);
  assert.equal(built.document.log.version, '1.2');
  assert.equal(built.document.log.entries.length, 1);
  assert.equal(built.document.log.creator.name, 'reqable-cli');
});

test('a HAR document reports zero unreadable bodies when every body is present', () => {
  const record = {
    url: 'http://h/ok',
    connection: { timestamp: '2026-01-01T00:00:00.000' },
    request: { method: 'GET', headers: [], protocol: 'HTTP/1.1', body: null },
    response: { code: 204, status: 'No Content', protocol: 'HTTP/1.1', headers: [], body: null },
  };
  const built = harDocument([record]);
  assert.equal(built.unreadableBodies, 0);
  assert.equal(built.document.log.entries[0].response.content.size, 0);
});

test('a binary request body is marked in HAR postData, which has no encoding field', () => {
  const entry = harEntry({
    url: 'http://h/upload',
    connection: { timestamp: '2026-01-01T00:00:00.000' },
    request: {
      method: 'POST',
      headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
      protocol: 'HTTP/1.1',
      body: { text: 'AA==', encoding: 'base64' },
    },
    response: null,
  });
  assert.equal(entry.request.postData.text, 'AA==');
  assert.equal(entry.request.postData.mimeType, 'application/octet-stream');
  assert.match(entry.request.postData.comment, /base64/);
  assert.equal(entry.request.bodySize, 1);
});

test('summarize is a stable, body-free view of a record', () => {
  const summary = summarize({
    id: 7,
    uid: 'u-7',
    protocol: 'http',
    url: 'http://h/a?b=1',
    request: { method: 'POST', body: { text: 'hello', encoding: 'utf8' } },
    response: null,
    application: { name: 'curl' },
    connection: { timestamp: '2026-01-01T00:00:00.000', remote: { ip: '1.2.3.4', port: 80 } },
  });

  assert.equal(summary.host, 'h');
  assert.equal(summary.path, '/a?b=1');
  assert.equal(summary.method, 'POST');
  assert.equal(summary.requestBodyBytes, 5);
  assert.equal(summary.statusCode, null);
  assert.equal(summary.responseBodyBytes, null);
  assert.equal(summary.remote, '1.2.3.4:80');
});

test('curlToSingleLine joins cmd continuations without rewriting inner spacing', () => {
  const raw = "curl -X GET 'http://h/p' ^\r\n-H 'X-Note: a  b' ^\r\n-H 'Accept: */*'";
  assert.equal(curlToSingleLine(raw), "curl -X GET 'http://h/p' -H 'X-Note: a  b' -H 'Accept: */*'");
  assert.equal(curlToSingleLine("curl -X GET 'a' \\\n  -H 'b'"), "curl -X GET 'a' -H 'b'");
  assert.equal(curlToSingleLine(undefined), null);
});

// --------------------------------------------------------------- argument parsing

test('parseArgs rejects an unknown flag, a bad number and a missing value', () => {
  assert.throws(() => parseArgs(['--nope'], { flags: {} }), (e) => e.code === 'USAGE');
  assert.throws(() => parseArgs(['--limit', 'x'], { flags: { limit: { type: 'number' } } }), (e) => e.code === 'USAGE');
  assert.throws(() => parseArgs(['--limit'], { flags: { limit: { type: 'number' } } }), (e) => e.code === 'USAGE');
  assert.throws(
    () => parseArgs([], { positionals: [{ name: 'id', required: true }] }),
    (e) => e.code === 'USAGE',
  );
});

test('parseArgs accepts the value forms the CLI documents', () => {
  assert.deepEqual(parseArgs(['--limit=5'], { flags: { limit: { type: 'number' } } }).values, { limit: 5 });
  assert.deepEqual(parseArgs(['--limit', '5'], { flags: { limit: { type: 'number' } } }).values, { limit: 5 });
  const list = { flags: { host: { type: 'list' } } };
  assert.deepEqual(parseArgs(['--host', 'a,b', '--host', 'c'], list).values.host, ['a', 'b', 'c']);
  assert.deepEqual(parseArgs(['--', '--not-a-flag'], { flags: {} }).positionals, ['--not-a-flag']);
});

test('-h means help wherever it appears', () => {
  assert.equal(parseArgs(['-h'], { flags: {} }).values.help, true);
  assert.equal(parseArgs(['--limit', '3', '-h'], { flags: { limit: { type: 'number' } } }).values.help, true);
});

// --------------------------------------------------------- help and parser parity

test('every help screen lists exactly the flags its command accepts', () => {
  // Documented globally and accepted everywhere, so a per-command listing would
  // be repetition: --json is in the root help, --help is in every screen.
  const globalOnly = new Set(['--json', '--help']);

  const cases = [
    ['status', statusHelp, rootFlags],
    ['replay', replayHelp, { ...rootFlags, ...replayFlags() }],
  ];
  for (const [name, sub] of Object.entries(captureSubcommands)) {
    cases.push([`capture ${name}`, sub.help, { ...rootFlags, ...sub.flags }]);
  }
  for (const [name, sub] of Object.entries(ruleSubcommands)) {
    cases.push([`rule ${name}`, sub.help, { ...rootFlags, ...sub.flags }]);
  }
  for (const [name, sub] of Object.entries(skillSubcommands)) {
    // The skill commands never talk to Reqable, so they take no transport flags.
    cases.push([`skill ${name}`, sub.help, { ...sub.flags }]);
  }

  for (const [label, help, flags] of cases) {
    const documented = [...renderHelp(help).matchAll(/^\s+(--[a-z-]+)/gm)]
      .map((match) => match[1])
      .filter((flag) => !globalOnly.has(flag));
    const accepted = Object.keys(flags)
      .map((name) => `--${name}`)
      .filter((flag) => !globalOnly.has(flag));

    assert.deepEqual(
      [...new Set(documented)].sort(),
      [...new Set(accepted)].sort(),
      `${label}: the help and the parser must agree on the flag set`,
    );
  }
});

test('the root help documents every global flag', () => {
  const rootHelp = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  for (const flag of ['--api-host', '--api-port', '--json', '--pretty', '--help', '--version']) {
    assert.ok(rootHelp.includes(flag), `the root help should mention ${flag}`);
  }
});

test('the skill commands take no transport flags, so they cannot advertise them', () => {
  const rendered = renderHelp(skillSubcommands.install.help);
  assert.ok(!rendered.includes('--api-host'), 'skill install must not advertise --api-host');
  assert.ok(!rendered.includes('--api-port'), 'skill install must not advertise --api-port');
});

// ------------------------------------------------------------------ exit codes

test('each error helper carries its documented exit code', () => {
  assert.deepEqual(EXIT, {
    OK: 0,
    INTERNAL: 1,
    USAGE: 2,
    UNREACHABLE: 3,
    API_ERROR: 4,
    NOT_FOUND: 5,
    CONFIRMATION_REQUIRED: 6,
  });
  assert.equal(usageError('x').exitCode, EXIT.USAGE);
  assert.equal(notFoundError('x').exitCode, EXIT.NOT_FOUND);
  assert.equal(confirmationError('x').exitCode, EXIT.CONFIRMATION_REQUIRED);
  assert.equal(unreachableError('x').exitCode, EXIT.UNREACHABLE);
  assert.equal(apiError('x').exitCode, EXIT.API_ERROR);
  assert.equal(new CliError('SOMETHING', 'x').exitCode, EXIT.INTERNAL);
});

// --------------------------------------------------------------- packaged skill

test('the default Codex skill directory is the dedicated one', () => {
  assert.equal(defaultSkillsDir(), path.join(os.homedir(), '.codex', 'skills'));
});

test('every file the skill install copies is present in this checkout', () => {
  const root = new URL('..', import.meta.url);
  const files = [
    'SKILL.md',
    'skill-zh.md',
    'references/install-and-config.md',
    'references/install-and-config-zh.md',
    'references/errors.md',
    'references/errors-zh.md',
  ];
  for (const relative of files) {
    assert.ok(fs.existsSync(new URL(relative, root)), `${relative} is missing, so skill install would fail`);
  }
});

test('package.json ships everything skill install needs', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const entry of ['SKILL.md', 'skill-zh.md', 'references/', 'bin/', 'src/', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), `package.json files must include ${entry}, or the tarball is incomplete`);
  }
});

// --------------------------------------------- host formatting and the envelope

test('formatHostPort brackets an IPv6 literal, because a URL string needs it', () => {
  assert.equal(formatHostPort('127.0.0.1', 9000), '127.0.0.1:9000');
  assert.equal(formatHostPort('::1', 9000), '[::1]:9000');
  // A bare "::1" is accepted by Node's HTTP client but produces
  // `http://::1:9000`, which the URL parser rejects. Prove the fixed form parses.
  assert.equal(new URL(`http://${formatHostPort('::1', 9000)}`).hostname, '[::1]');
});

test('bareHost strips the brackets a URL parser adds, so net.isIP can answer', () => {
  assert.equal(bareHost('[::1]'), '::1');
  assert.equal(bareHost('::1'), '::1');
  assert.equal(bareHost('example.com'), 'example.com');
  // The bug this exists for: net.isIP gets a bracketed literal and says "not an
  // IP", which is how an IP address ended up in the SNI field.
  assert.equal(net.isIP('[::1]'), 0);
  assert.equal(net.isIP(bareHost('[::1]')), 6);
});

test('a bad --api-port or --api-host fails as a JSON envelope, not a stack trace', () => {
  // The constructor validates these two flags and throws CliError. It used to be
  // built outside run()'s try/catch, so the throw escaped as a raw Node stack on
  // stderr, stdout stayed empty, and the process exited 1 -- breaking the
  // "stdout is always one JSON object, exit codes are fixed" contract for two
  // of the ten entry points. Both the leaf path (status) and the branch path
  // (capture list) must be covered: they construct the client separately.
  const cli = fileURLToPath(new URL('../bin/reqable-cli.js', import.meta.url));
  const cases = [
    [['status', '--api-port', '0'], '--api-port expects a whole number'],
    [['status', '--api-port', 'abc'], 'expects a number'],
    [['status', '--api-host', '[::1]'], 'expects a bare address'],
    [['capture', 'list', '--api-port', '0'], '--api-port expects a whole number'],
    [['rule', 'list', '--api-host', '[::1]'], 'expects a bare address'],
  ];

  for (const [argv, fragment] of cases) {
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [cli, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stdout = error.stdout ?? '';
      status = error.status;
    }
    const label = argv.join(' ');
    assert.equal(status, EXIT.USAGE, `${label} should exit 2`);

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(stdout);
    }, `${label} should print one JSON object on stdout, got: ${JSON.stringify(stdout.slice(0, 200))}`);
    assert.equal(parsed.ok, false, `${label} should report failure`);
    assert.equal(parsed.error.exitCode, EXIT.USAGE);
    assert.match(parsed.error.message, new RegExp(fragment), `${label} should explain the flag`);
  }
});

test('the documented Node floor matches package.json engines', () => {
  // The floor is not cosmetic: `skill install` calls import.meta.dirname, so a
  // Node below 20.11 installs fine (npm does not enforce engines by default)
  // and then fails with an internal error on the one command that needs it.
  // Both documents said "18 or newer" while engines said 20.11, which is how a
  // stranger on Node 18 would have been led straight into that failure.
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  const match = /^>=\s*(\d+\.\d+)/.exec(pkg.engines.node);
  assert.ok(match, `engines.node must state a floor, got ${JSON.stringify(pkg.engines.node)}`);
  const floor = match[1];

  for (const relative of ['README.md', 'references/install-and-config.md', 'references/install-and-config-zh.md']) {
    const text = fs.readFileSync(new URL(relative, root), 'utf8');
    assert.ok(text.includes(floor), `${relative} must state the Node floor ${floor}, as package.json does`);
    const stale = /\bNode(?:\.js)?\s+(?:1[0-9]|8)[\s.]/.exec(text);
    assert.equal(stale, null, `${relative} still advertises an older Node: ${stale?.[0]}`);
  }
});

test('--force replaces a link at the target without touching what it points to', (t) => {
  // The forced branch removes <dir>/reqable-cli before writing. If it ever
  // followed a link instead of removing it, `skill install --force` could empty
  // a directory the caller never named. It removes the link; this pins that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqable-cli-link-'));
  const real = path.join(dir, 'real-target');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'keepme.txt'), 'precious');

  const link = path.join(dir, 'reqable-cli');
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('this platform or account cannot create links');
    return;
  }

  const cli = fileURLToPath(new URL('../bin/reqable-cli.js', import.meta.url));
  const stdout = execFileSync(process.execPath, [cli, 'skill', 'install', '--dir', dir, '--force'], {
    encoding: 'utf8',
  });

  assert.equal(JSON.parse(stdout).ok, true, 'the forced install should report success');
  assert.ok(fs.existsSync(path.join(real, 'keepme.txt')), 'what the link pointed at must survive');
  assert.ok(!fs.lstatSync(link).isSymbolicLink(), 'the target must end up a real directory, not a link');
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), 'the install should have written the skill there');
});

// ------------------------------------------------- skill install input handling

/** Run the CLI and always return its exit code, stdout and stderr. */
function runCli(argv, env = {}) {
  const cli = fileURLToPath(new URL('../bin/reqable-cli.js', import.meta.url));
  try {
    const stdout = execFileSync(process.execPath, [cli, ...argv], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('skill install reports an unusable --dir as a usage error, not an internal one', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reqable-cli-dir-'));
  const aFile = path.join(workspace, 'a-file');
  fs.writeFileSync(aFile, 'not a directory');

  // Each of these used to reach mkdirSync and surface as INTERNAL_ERROR with
  // exit 1 -- the code reserved for "this is a bug, report it". None of them is.
  const cases = [
    [['--dir', aFile], /which is a file/],
    [['--dir=', ], /empty value/],
    [['--dir', path.join(aFile, 'under-a-file')], /ENOTDIR|cannot be used/],
  ];
  for (const [args, expected] of cases) {
    const result = runCli(['skill', 'install', ...args]);
    const label = `skill install ${args.join(' ')}`;
    assert.equal(result.status, EXIT.USAGE, `${label} should exit 2, got ${result.status}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'USAGE');
    assert.match(parsed.error.message, expected);
  }
});

test('skill install takes a linked --dir, and refuses a file at the target', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'reqable-cli-dirlink-'));
  const realSkills = path.join(workspace, 'real-skills');
  fs.mkdirSync(realSkills);
  const linked = path.join(workspace, 'linked-skills');
  try {
    fs.symlinkSync(realSkills, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('this platform or account cannot create links');
    return;
  }

  // A skills directory kept in a dotfiles repository is a symlink, so an lstat
  // check here would reject a layout that works.
  const installed = runCli(['skill', 'install', '--dir', linked]);
  assert.equal(installed.status, 0, installed.stdout);
  assert.ok(fs.existsSync(path.join(realSkills, 'reqable-cli', 'SKILL.md')), 'the skill should land behind the link');

  // A regular file sitting where the skill directory belongs is a confirmation
  // case, not a crash: exit 6 without --force, and a clean install with it.
  const blocked = path.join(workspace, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'reqable-cli'), 'a file in the way');
  const refused = runCli(['skill', 'install', '--dir', blocked]);
  assert.equal(refused.status, EXIT.CONFIRMATION_REQUIRED);
  assert.equal(JSON.parse(refused.stdout).error.code, 'CONFIRMATION_REQUIRED');
  assert.match(JSON.parse(refused.stdout).error.message, /already exists as a file/);

  const forced = runCli(['skill', 'install', '--dir', blocked, '--force']);
  assert.equal(forced.status, 0, forced.stdout);
  assert.ok(fs.statSync(path.join(blocked, 'reqable-cli')).isDirectory());
});

test('REQABLE_CLI_DEBUG prints a stack only when it is actually on', () => {
  // `=0` is how a caller turns it off in a shell that already exported it, and a
  // truthy test read that as "on".
  const argv = ['status', '--api-host', '[::1]'];

  const off = runCli(argv, { REQABLE_CLI_DEBUG: '0' });
  assert.equal(off.status, EXIT.USAGE);
  assert.equal(off.stderr, '', 'REQABLE_CLI_DEBUG=0 must stay quiet');

  const on = runCli(argv, { REQABLE_CLI_DEBUG: '1' });
  assert.equal(on.status, EXIT.USAGE);
  assert.match(on.stderr, /CliError/, 'REQABLE_CLI_DEBUG=1 should print the stack to stderr');
  // Either way stdout stays one JSON object: diagnostics never go there.
  assert.equal(JSON.parse(off.stdout).ok, false);
  assert.equal(JSON.parse(on.stdout).ok, false);
});

test('the declared platform matches what the code and the documents say', () => {
  // The storage root is a Windows path read from %APPDATA%. Declaring the
  // platform is what stops npm from installing this on a machine where that
  // lookup would find nothing and report a port problem instead of a platform
  // one. macOS and Linux roots were removed rather than guessed at, so nothing
  // may quietly reintroduce the claim that they are supported.
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  assert.deepEqual(pkg.os, ['win32'], 'package.json must declare the platform this was verified on');

  const source = fs.readFileSync(new URL('src/reqable.js', root), 'utf8');
  assert.match(source, /%APPDATA%/, 'the storage root should name the Windows location it reads');
  for (const guess of ['com.reqable.macosx', 'com.reqable.linux']) {
    assert.ok(!source.includes(guess), `${guess} is an unverified path and must not be back in the code`);
  }

  for (const relative of ['README.md', 'references/install-and-config.md', 'references/install-and-config-zh.md']) {
    const text = fs.readFileSync(new URL(relative, root), 'utf8');
    assert.match(text, /Windows/, `${relative} must state the supported platform`);
  }
});
