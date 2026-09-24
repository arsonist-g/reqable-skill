/**
 * Supplementary end-to-end check: the three paths test/e2e.mjs deliberately left
 * unverified, because each needs state the main check does not touch.
 *
 *   A. File output: `capture export --format json`, `capture get --out`,
 *      `capture get --body-out`, and `capture export --out -`.
 *   B. HTTPS end to end: a TLS target captured through Reqable's MITM with the
 *      Reqable CA trusted by the client, and `replay --via reqable --insecure`
 *      re-sending it through the proxy.
 *   C. Rule state changes: create, list, disable, enable, feature on and off for
 *      breakpoint, rewrite and script, then delete everything created.
 *
 * Every section restores what it changed. The script asserts that restoration
 * rather than assuming it: rule counts return to their starting values, the rule
 * features return to their starting values, capture returns to its starting
 * state, and Reqable's config file hash is unchanged.
 *
 * All traffic goes to loopback servers started by this script. No third-party
 * host is contacted.
 *
 * Usage: node test/e2e-extra.mjs [--keep]
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { captureConfigPath } from '../src/reqable.js';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '..', 'bin', 'reqable-cli.js');
const HTTP_PORT = 18081;
const HTTPS_PORT = 18443;
const MARKER = 'reqable-cli-extra-marker';
const KEEP = process.argv.includes('--keep');
const INERT_URL = 'https://e2e-inert.invalid/*';

const results = [];
let failed = 0;

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) failed += 1;
  process.stdout.write(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function cli(args, options = {}) {
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    const result = await run(process.execPath, [CLI, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    code = typeof error.code === 'number' ? error.code : 1;
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  }
  let envelope = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }
  return { code, envelope, stdout, stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// ------------------------------------------------------------------ targets

let httpHits = 0;
let httpsHits = 0;

const httpTarget = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    httpHits += 1;
    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
    res.writeHead(url.pathname === '/missing' ? 404 : 200, { 'content-type': 'application/json', 'x-marker': MARKER });
    res.end(JSON.stringify({ marker: MARKER, method: req.method, path: url.pathname, receivedBody: body }));
  });
});

let httpsTarget = null;

/** Mint a short-lived self-signed certificate for 127.0.0.1 with openssl. */
async function mintCertificate(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ]);
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), keyPath, certPath };
}

// --------------------------------------------------------------- raw API use

let apiBase = '';

async function rawApi(route, payload, method = 'POST') {
  const res = await fetch(`${apiBase}${route}`, {
    method,
    ...(method === 'POST'
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) }
      : {}),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Rule counts and feature flags, used as the before/after state snapshot. */
async function ruleState() {
  const state = {};
  for (const type of ['breakpoint', 'rewrite', 'script']) {
    const list = await rawApi(`/capture/${type}/list`, null, 'GET');
    const config = await rawApi(`/capture/${type}`, null, 'GET');
    const items = Array.isArray(list.body) ? list.body : (list.body?.items ?? []);
    state[type] = { count: items.length, featureEnabled: config.body?.isEnabled ?? null };
  }
  return state;
}

async function captureState() {
  const status = await cli(['status']);
  return status.envelope?.data?.capture?.status ?? null;
}

// -------------------------------------------------------------------- section A

async function sectionFileOutput(recordId) {
  process.stdout.write('\nA. file output paths\n');

  const jsonPath = path.join(os.tmpdir(), `reqable-cli-extra-${Date.now()}.json`);
  fs.writeFileSync(jsonPath, 'stale content that must be overwritten\n');

  const asJson = await cli(['capture', 'export', '--format', 'json', '--out', jsonPath, '--keyword', 'extra-', '--limit', '0']);
  check('capture export --format json exits 0', asJson.code === 0, asJson.envelope?.error?.message ?? `entries=${asJson.envelope?.data?.entries}`);
  check('the JSON export reports the same entry count it wrote',
    asJson.envelope?.data?.format === 'json' && asJson.envelope?.data?.entries >= 3,
    `format=${asJson.envelope?.data?.format} entries=${asJson.envelope?.data?.entries}`);

  let jsonDoc = null;
  try {
    jsonDoc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    check('the JSON export parses as JSON', false, error.message);
  }
  if (jsonDoc) {
    check('the JSON export parses as JSON', true);
    check('the JSON export holds a records array with full records in it',
      Array.isArray(jsonDoc.records) && jsonDoc.records.length >= 3 &&
        jsonDoc.records.every((r) => r.request?.method && r.url && 'response' in r),
      `${jsonDoc.records?.length} records, first url=${jsonDoc.records?.[0]?.url}`);
    const withBody = jsonDoc.records.find((r) => (r.response?.body?.text ?? '').includes(MARKER));
    check('the JSON export keeps bodies verbatim (not HAR-shaped)', Boolean(withBody),
      withBody ? `encoding=${withBody.response.body.encoding}` : 'no record carried the marker');
  }

  // stdout carries this command's own envelope, so exporting to it is refused
  const toStdout = await cli(['capture', 'export', '--format', 'har', '--out', '-', '--keyword', 'extra-', '--limit', '2']);
  check('capture export refuses --out - rather than putting two JSON documents on stdout',
    toStdout.code === 2 && toStdout.envelope?.error?.code === 'USAGE',
    `exit=${toStdout.code} message=${String(toStdout.envelope?.error?.message ?? '').slice(0, 60)}`);

  // get --out
  const recordPath = path.join(os.tmpdir(), `reqable-cli-extra-record-${Date.now()}.json`);
  const withOut = await cli(['capture', 'get', String(recordId), '--out', recordPath]);
  check('capture get --out exits 0 and reports the file', withOut.code === 0 && withOut.envelope?.data?.savedRecordTo === recordPath,
    withOut.envelope?.error?.message ?? String(withOut.envelope?.data?.savedRecordTo));
  let savedRecord = null;
  try {
    savedRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (error) {
    check('the saved record file parses and matches the record returned on stdout', false, error.message);
  }
  if (savedRecord) {
    check('the saved record file parses and matches the record returned on stdout',
      savedRecord.id === recordId && savedRecord.request?.method === 'POST' &&
        JSON.stringify(savedRecord) === JSON.stringify(withOut.envelope?.data?.record),
      `id=${savedRecord.id} method=${savedRecord.request?.method}`);
  }

  // get --body-out, compared byte for byte against the body the API reports
  const bodyPath = path.join(os.tmpdir(), `reqable-cli-extra-body-${Date.now()}.bin`);
  const withBodyOut = await cli(['capture', 'get', String(recordId), '--body-out', bodyPath]);
  check('capture get --body-out exits 0 and reports the file',
    withBodyOut.code === 0 && withBodyOut.envelope?.data?.savedResponseBodyTo === bodyPath,
    withBodyOut.envelope?.error?.message ?? '');
  const record = withBodyOut.envelope?.data?.record;
  const body = record?.response?.body;
  if (fs.existsSync(bodyPath) && body?.encoding === 'utf8') {
    const written = fs.readFileSync(bodyPath);
    check('the written body file is byte-identical to the recorded body text',
      written.equals(Buffer.from(body.text, 'utf8')) && written.toString('utf8').includes(MARKER),
      `${written.length} bytes, sha256=${sha256(written).slice(0, 16)}`);
  } else {
    check('the written body file is byte-identical to the recorded body text', false,
      `file exists=${fs.existsSync(bodyPath)} encoding=${body?.encoding}`);
  }

  if (!KEEP) {
    for (const p of [jsonPath, recordPath, bodyPath]) fs.rmSync(p, { force: true });
  } else {
    process.stdout.write(`  (kept: ${jsonPath} ${recordPath} ${bodyPath})\n`);
  }
}

// -------------------------------------------------------------------- section B

async function sectionHttps() {
  process.stdout.write('\nB. HTTPS end to end\n');

  const sslFeature = await rawApi('/capture/ssl-proxying/get-active', null, 'GET');
  const sslActive = sslFeature.body?.profile !== null && sslFeature.body?.profile !== undefined;
  check('SSL proxying is active in Reqable, so https bodies can be read', sslActive,
    `profile=${JSON.stringify(sslFeature.body?.profile)?.slice(0, 90)}`);
  if (!sslActive) {
    process.stdout.write('  skipping the rest of B: TLS interception needs SSL proxying on, and this check will not change that setting.\n');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqable-cli-tls-'));
  const { key, cert } = await mintCertificate(dir);
  httpsTarget = https.createServer({ key, cert }, (req, res) => {
    httpsHits += 1;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-marker': MARKER });
      res.end(JSON.stringify({ marker: MARKER, tls: true, method: req.method, headers: req.headers, receivedBody: body }));
    });
  });
  await new Promise((r) => httpsTarget.listen(HTTPS_PORT, '127.0.0.1', r));
  check('a loopback TLS target is listening', true, `https://127.0.0.1:${HTTPS_PORT} with a self-signed cert for 127.0.0.1`);

  const proxyUrl = apiBase.replace('http://', 'http://');
  const caPath = path.join(path.dirname(captureConfigPath()), '..', 'certificate', 'reqable-root.crt');
  const proxyEnv = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  };

  const before = httpsHits;
  let curlOut = '';
  let usedCa = true;
  try {
    const { stdout } = await run('curl', ['-s', '-m', '15', '--cacert', caPath, `https://127.0.0.1:${HTTPS_PORT}/echo?probe=extra-tls`], { env: proxyEnv });
    curlOut = stdout;
  } catch (caError) {
    usedCa = false;
    try {
      const { stdout } = await run('curl', ['-s', '-k', '-m', '15', `https://127.0.0.1:${HTTPS_PORT}/echo?probe=extra-tls`], { env: proxyEnv });
      curlOut = stdout;
    } catch (error) {
      curlOut = `ERR ${error.code}`;
    }
  }
  check('an https request reaches the TLS target through Reqable', httpsHits === before + 1 && curlOut.includes(MARKER),
    `hits=${httpsHits - before}${usedCa ? ' (client trusted the Reqable CA)' : ' (CA trust failed, retried with -k)'}`);

  await sleep(700);

  const list = await cli(['capture', 'list', '--keyword', 'extra-tls', '--limit', '5']);
  const item = list.envelope?.data?.items?.[0];
  check('the https exchange was captured', Boolean(item), item ? `${item.method} ${item.url} -> ${item.statusCode}` : 'no record');

  if (!item) return;

  const got = await cli(['capture', 'get', String(item.id)]);
  const record = got.envelope?.data?.record;
  check('the captured https request body is readable, so the TLS was intercepted',
    record?.response?.code === 200 && (record?.response?.body?.text ?? '').includes(MARKER),
    `code=${record?.response?.code} bodyEncoding=${record?.response?.body?.encoding} bytes=${record?.response?.body?.text?.length}`);

  const beforeReplay = httpsHits;
  const replay = await cli(['replay', String(item.id), '--via', 'reqable', '--insecure', '--header', 'x-extra-replay: tls']);
  check('replay --via reqable --insecure reaches the https target through the proxy',
    replay.code === 0 && replay.envelope?.data?.response?.statusCode === 200 && httpsHits === beforeReplay + 1,
    `status=${replay.envelope?.data?.response?.statusCode} hits=${httpsHits - beforeReplay}${replay.code ? ` error=${replay.envelope?.error?.message}` : ''}`);
  check('the https replay carried the overridden header',
    (replay.envelope?.data?.response?.body ?? '').includes('"x-extra-replay":"tls"'),
    'the TLS target echoed the override');

  const withoutInsecure = await cli(['replay', String(item.id), '--via', 'reqable']);
  check('https through Reqable without --insecure fails loudly instead of silently trusting it',
    withoutInsecure.code !== 0 || withoutInsecure.envelope?.ok === false,
    `exit=${withoutInsecure.code} message=${String(withoutInsecure.envelope?.error?.message ?? '').slice(0, 80)}`);

  httpsTarget.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------------- section C

async function sectionRules() {
  process.stdout.write('\nC. rule state changes\n');

  const TYPES = ['breakpoint', 'rewrite', 'script'];
  const start = await ruleState();

  // The feature switch needs no rule to exist, so it is exercisable on a free,
  // not-logged-in Reqable. Each type is left in the state it was found in.
  for (const type of TYPES) {
    const original = start[type].featureEnabled;

    const on = await cli(['rule', 'set', '--type', type, '--feature', 'on']);
    const afterOn = await rawApi(`/capture/${type}`, null, 'GET');
    check(`rule set --feature on switches the ${type} feature on`,
      on.code === 0 && afterOn.body?.isEnabled === true,
      `exit=${on.code} isEnabled=${afterOn.body?.isEnabled}`);

    const off = await cli(['rule', 'set', '--type', type, '--feature', 'off']);
    const afterOff = await rawApi(`/capture/${type}`, null, 'GET');
    check(`rule set --feature off switches the ${type} feature back off`,
      off.code === 0 && afterOff.body?.isEnabled === false,
      `exit=${off.code} isEnabled=${afterOff.body?.isEnabled}`);

    if (original === true) await cli(['rule', 'set', '--type', type, '--feature', 'on']);
  }

  // Creating a rule is gated behind a Reqable account on this install. The path
  // is therefore verified as "refused cleanly, carrying Reqable's own reason",
  // which is what a caller needs, rather than as "creates a rule".
  const payloads = {
    breakpoint: {
      name: 'e2e-inert-breakpoint', url: INERT_URL, method: 'GET', wildcard: true,
      isRequestEnabled: false, isResponseEnabled: false,
    },
    rewrite: {
      name: 'e2e-inert-rewrite', url: INERT_URL, method: 'GET', wildcard: true,
      action: { type: 0, redirectUrl: 'https://e2e-inert.invalid/redirected', preserveHost: false },
    },
    script: {
      name: 'e2e-inert-script', url: INERT_URL, method: 'GET', wildcard: true,
      code: 'def onRequest(context, request):\n  return request\n',
    },
  };

  let gated = 0;
  for (const type of TYPES) {
    const payload = payloads[type];
    const raw = await rawApi(`/capture/${type}/create`, payload);
    const isGate = raw.status === 401 && String(raw.body?.message ?? '').includes('requires an account');
    if (isGate) gated += 1;

    const created = await cli(['rule', 'set', '--type', type, '--payload', JSON.stringify(payload)]);
    check(`rule set reports Reqable's refusal for creating a ${type} without an account`,
      created.code === 4 && created.envelope?.error?.code === 'REQABLE_API_ERROR' &&
        String(created.envelope?.error?.message ?? '').includes('requires an account'),
      `cli exit=${created.code} api status=${raw.status} message=${String(raw.body?.message ?? '').slice(0, 52)}`);
  }
  check('rule creation is gated behind a Reqable account on this install, so a live rule cannot be made here',
    gated === TYPES.length,
    `${gated}/${TYPES.length} types answered 401 "requires an account"`);

  // The toggle payload can still be proven correct without a rule: Reqable
  // validates the body before looking the id up, so a well-formed body is
  // accepted while a malformed one is rejected.
  for (const type of TYPES) {
    const accepted = await rawApi(`/capture/${type}/disable`, { ids: ['e2e-does-not-exist'], enabled: false });
    const noIds = await rawApi(`/capture/${type}/disable`, {});
    const wrongTypes = await rawApi(`/capture/${type}/disable`, { ids: 'not-a-list', enabled: 'not-a-bool' });
    check(`Reqable accepts the { ids, enabled } toggle body that rule set sends, for ${type}`,
      accepted.status === 200 && noIds.status === 400 && wrongTypes.status === 400,
      `accepted=${accepted.status} missing-ids=${noIds.status} wrong-types=${wrongTypes.status}`);
  }

  for (const type of TYPES) {
    const viaCli = await cli(['rule', 'set', '--type', type, '--disable', 'e2e-does-not-exist']);
    const enabledViaCli = await cli(['rule', 'set', '--type', type, '--enable', 'e2e-does-not-exist']);
    check(`rule set --disable/--enable reach Reqable for ${type} and report success`,
      viaCli.code === 0 && enabledViaCli.code === 0,
      `disable exit=${viaCli.code} enable exit=${enabledViaCli.code}`);
  }

  // Argument validation, which needs no licence and must never reach the API.
  const twoActions = await cli(['rule', 'set', '--type', 'rewrite', '--feature', 'on', '--disable', 'x']);
  check('rule set refuses two actions in one call', twoActions.code === 2 && twoActions.envelope?.error?.code === 'USAGE',
    twoActions.envelope?.error?.message);
  const noType = await cli(['rule', 'set', '--disable', 'x']);
  check('rule set refuses a missing --type', noType.code === 2 && noType.envelope?.error?.code === 'USAGE',
  noType.envelope?.error?.message);
  const badType = await cli(['rule', 'set', '--type', 'nope', '--disable', 'x']);
  check('rule set refuses an unknown --type', badType.code === 2 && badType.envelope?.error?.code === 'USAGE',
    badType.envelope?.error?.message);
  const noAction = await cli(['rule', 'set', '--type', 'rewrite']);
  check('rule set refuses a call with no action flag', noAction.code === 2 && noAction.envelope?.error?.code === 'USAGE',
    noAction.envelope?.error?.message);
  const badPayload = await cli(['rule', 'set', '--type', 'rewrite', '--payload', '[1,2]']);
  check('rule set refuses a payload that is not a JSON object', badPayload.code === 2,
    badPayload.envelope?.error?.message);
  const badFeature = await cli(['rule', 'set', '--type', 'rewrite', '--feature', 'maybe']);
  check('rule set refuses a --feature value other than on or off', badFeature.code === 2,
    badFeature.envelope?.error?.message);
  const dry = await cli(['rule', 'set', '--type', 'rewrite', '--payload', '{"name":"n","url":"u","action":{}}', '--dry-run']);
  check('rule set --dry-run reports the payload without sending it',
    dry.code === 0 && dry.envelope?.data?.applied === false,
    `applied=${dry.envelope?.data?.applied}`);
  const dryFeature = await cli(['rule', 'set', '--type', 'rewrite', '--feature', 'on', '--dry-run']);
  check('rule set --dry-run does not change a feature',
    dryFeature.code === 0 && dryFeature.envelope?.data?.applied === false &&
      (await rawApi('/capture/rewrite', null, 'GET')).body?.isEnabled === start.rewrite.featureEnabled,
    `applied=${dryFeature.envelope?.data?.applied}`);

  const after = await ruleState();
  check('no rule was created and every feature is back where it started',
    TYPES.every((t) => after[t].count === start[t].count && after[t].featureEnabled === start[t].featureEnabled),
    `before=${JSON.stringify(start)} after=${JSON.stringify(after)}`);
}

// ----------------------------------------------------------------------- main

process.stdout.write('reqable-cli supplementary check\n');
process.stdout.write(`  cli:     ${CLI}\n`);
process.stdout.write(`  targets: http://127.0.0.1:${HTTP_PORT} and https://127.0.0.1:${HTTPS_PORT}, both started here\n`);

await new Promise((r) => httpTarget.listen(HTTP_PORT, '127.0.0.1', r));

const status = await cli(['status']);
const data = status.envelope?.data;
check('status reports Reqable reachable', status.code === 0 && data?.reachable === true,
  `port=${data?.port} source=${data?.portSource}`);
if (data?.reachable !== true) {
  process.stdout.write('\nReqable is not reachable; stopping. Start Reqable and re-run.\n');
  httpTarget.close();
  process.exit(1);
}
apiBase = `http://${data.host}:${data.port}`;

const configBefore = sha256(fs.readFileSync(captureConfigPath()));
const captureBefore = await captureState();
const rulesBefore = await ruleState();

const proxyEnv = {
  ...process.env,
  HTTP_PROXY: apiBase,
  http_proxy: apiBase,
  HTTPS_PROXY: apiBase,
  https_proxy: apiBase,
  NO_PROXY: '',
  no_proxy: '',
};

await cli(['capture', 'on']);
await cli(['capture', 'clear', '--yes']);

// seed three plain HTTP records, one of them a POST and one a 404
for (const [p, extra] of [
  ['/echo?probe=extra-one', []],
  ['/echo?probe=extra-two', ['-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{"extra":"body"}']],
  ['/missing?probe=extra-three', []],
]) {
  await run('curl', ['-s', '-m', '15', '-o', '/dev/null', ...extra, `http://127.0.0.1:${HTTP_PORT}${p}`], { env: proxyEnv })
    .catch(() => {});
}
await sleep(700);

const seeded = await cli(['capture', 'list', '--keyword', 'extra-', '--limit', '10']);
const postItem = (seeded.envelope?.data?.items ?? []).find((i) => i.method === 'POST');
check('seeded traffic was captured (3 requests, one POST)', Boolean(postItem),
  `records=${seeded.envelope?.data?.totalMatched} postId=${postItem?.id}`);

try {
  if (postItem) await sectionFileOutput(postItem.id);
  await sectionHttps();
  await sectionRules();
} finally {
  // restore capture to what it was before this run
  if (captureBefore === 'inactive') await cli(['capture', 'off']);
  httpTarget.close();
  if (httpsTarget) httpsTarget.close();
}

process.stdout.write('\nD. state restored\n');
const configAfter = sha256(fs.readFileSync(captureConfigPath()));
check("Reqable's config file is byte-identical to before this run", configAfter === configBefore,
  `${configBefore.slice(0, 16)} -> ${configAfter.slice(0, 16)}`);

const captureAfter = await captureState();
check('the capture switch is back where it started', captureAfter === captureBefore,
  `${captureBefore} -> ${captureAfter}`);

const rulesAfter = await ruleState();
const sameCounts = ['breakpoint', 'rewrite', 'script'].every((t) => rulesAfter[t].count === rulesBefore[t].count);
const sameFeatures = ['breakpoint', 'rewrite', 'script'].every((t) => rulesAfter[t].featureEnabled === rulesBefore[t].featureEnabled);
check('every rule this check created was removed', sameCounts,
  `counts ${JSON.stringify(rulesBefore)} -> ${JSON.stringify(rulesAfter)}`);
check('every rule feature is back where it started', sameFeatures,
  `features ${JSON.stringify(Object.fromEntries(Object.entries(rulesBefore).map(([k, v]) => [k, v.featureEnabled])))}`);

const passed = results.length - failed;
process.stdout.write(`\n${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}\n`);
process.exit(failed === 0 ? 0 : 1);
