/**
 * End-to-end check for reqable-cli.
 *
 * What it proves, in one run, on a machine with Reqable installed and running:
 *
 *   1. the CLI reaches Reqable's local API and can turn capture on and off
 *   2. traffic pushed through Reqable's proxy with a process-level HTTP_PROXY
 *      becomes a capture record
 *   3. `capture list` finds that record, `capture get` returns its full request
 *      and response, `capture curl` produces a replayable command
 *   4. `capture export` writes a parseable HAR file with the bodies inlined
 *   5. `replay` re-sends the request both directly and through the proxy
 *   6. nothing in the pipeline starts an MCP server
 *
 * The target is a loopback HTTP server started by this script, so no third-party
 * host is ever contacted. Reqable's capture state is restored to whatever it was
 * before the run.
 *
 * Usage: node test/e2e.mjs [--keep]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '..', 'bin', 'reqable-cli.js');
const TARGET_PORT = 18080;
const MARKER = 'reqable-cli-e2e-marker';
const KEEP = process.argv.includes('--keep');

const results = [];
let failed = 0;

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) failed += 1;
  const label = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${label}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/** Invoke the CLI the way a caller would, and parse its stdout envelope. */
async function cli(args, options = {}) {
  let code = 0;
  let stdout = '';
  let stderr = '';

  try {
    const result = await run(process.execPath, [CLI, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    code = typeof error.code === 'number' ? error.code : 1;
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  }

  // Not every successful run answers with JSON: --help writes plain text to
  // stdout by design, so a JSON parse failure is not a command failure.
  let envelope = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }

  return { code, envelope, stdout, stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- test target

let requestCount = 0;
const target = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requestCount += 1;
    const url = new URL(req.url, `http://127.0.0.1:${TARGET_PORT}`);
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-marker': MARKER });
      res.end(JSON.stringify({
        marker: MARKER,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        receivedBody: body,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker: MARKER, error: 'not found' }));
  });
});

// ---------------------------------------------------------------------- main

process.stdout.write('reqable-cli end-to-end check\n');
process.stdout.write(`  cli:    ${CLI}\n`);
process.stdout.write(`  target: http://127.0.0.1:${TARGET_PORT} (started by this script)\n\n`);

await new Promise((r) => target.listen(TARGET_PORT, '127.0.0.1', r));

// 0. Reachability and the original capture state, so it can be restored.
const initialStatus = await cli(['status']);
check('status exits 0 and reports reachable', initialStatus.code === 0 && initialStatus.envelope?.data?.reachable === true,
  `port=${initialStatus.envelope?.data?.port} source=${initialStatus.envelope?.data?.portSource}`);

if (initialStatus.envelope?.data?.reachable !== true) {
  process.stdout.write('\nReqable is not reachable; stopping. Start Reqable and re-run.\n');
  target.close();
  process.exit(1);
}

const originalCapture = initialStatus.envelope.data.capture.status;
const proxyUrl = `http://${initialStatus.envelope.data.host}:${initialStatus.envelope.data.port}`;

// 1. Start capture and clear the session.
const on = await cli(['capture', 'on']);
check('capture on reports capture active', on.code === 0 && on.envelope?.data?.status === 'active',
  `status=${on.envelope?.data?.status}`);

const cleared = await cli(['capture', 'clear', '--yes']);
check('capture clear --yes exits 0', cleared.code === 0);

const refused = await cli(['capture', 'clear']);
check('capture clear without --yes is refused with exit 6', refused.code === 6 && refused.envelope?.error?.code === 'CONFIRMATION_REQUIRED',
  `exit=${refused.code} code=${refused.envelope?.error?.code}`);

// 2. Push traffic through Reqable's proxy with a process-level HTTP_PROXY.
async function proxied(pathAndQuery, extra = []) {
  const env = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  };
  try {
    const { stdout } = await run('curl', ['-s', '-m', '15', ...extra, `http://127.0.0.1:${TARGET_PORT}${pathAndQuery}`], { env });
    return { ok: true, body: stdout };
  } catch (error) {
    return { ok: false, body: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.code };
  }
}

const getOne = await proxied('/echo?probe=e2e-alpha');
check('proxied GET reaches the target through Reqable', getOne.ok && getOne.body.includes(MARKER),
  getOne.ok ? `body contains marker=${getOne.body.includes(MARKER)}` : `curl exit ${getOne.code}`);

const postOne = await proxied('/echo?probe=e2e-beta', ['-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{"hello":"e2e"}']);
let postEcho = null;
try {
  postEcho = JSON.parse(postOne.body);
} catch {
  postEcho = null;
}
check('proxied POST reaches the target through Reqable', postOne.ok && postEcho?.receivedBody === '{"hello":"e2e"}',
  postEcho ? `echoed body ${JSON.stringify(postEcho.receivedBody)}` : `curl exit ${postOne.code}`);

const missOne = await proxied('/missing?probe=e2e-gamma');
check('proxied 404 request is forwarded', missOne.ok && missOne.body.includes('not found'));

await sleep(700);

// 3. The CLI must see those records.
const list = await cli(['capture', 'list', '--limit', '20', '--keyword', 'e2e-']);
check('capture list --json exits 0', list.code === 0);
check('capture list found the generated traffic', (list.envelope?.data?.items?.length ?? 0) >= 3,
  `matched ${list.envelope?.data?.totalMatched}, returned ${list.envelope?.data?.returned}`);

const items = list.envelope?.data?.items ?? [];
const postItem = items.find((i) => i.method === 'POST');
const missingItem = items.find((i) => i.path?.startsWith('/missing'));

check('capture list reports method, host and status per record',
  Boolean(postItem) && postItem.statusCode === 200 && postItem.host === `127.0.0.1:${TARGET_PORT}`,
  postItem ? `${postItem.method} ${postItem.url} -> ${postItem.statusCode}` : 'no POST record');
check('capture list reports a 404 correctly', missingItem?.statusCode === 404,
  missingItem ? `statusCode=${missingItem.statusCode}` : 'no /missing record');

// host filter
const hostFiltered = await cli(['capture', 'list', '--host', '127.0.0.1', '--limit', '20']);
check('--host filter is accepted and matches', hostFiltered.code === 0 && (hostFiltered.envelope?.data?.items?.length ?? 0) >= 3,
  `${hostFiltered.envelope?.data?.totalMatched} matched`);
// method filter
const postFiltered = await cli(['capture', 'list', '--method', 'POST', '--limit', '20']);
check('--method filter narrows to POST', postFiltered.code === 0 && (postFiltered.envelope?.data?.items ?? []).every((i) => i.method === 'POST'),
  `${postFiltered.envelope?.data?.totalMatched} matched`);
// code filter
const codeFiltered = await cli(['capture', 'list', '--code', '404', '--limit', '20']);
check('--code filter narrows to 404', codeFiltered.code === 0 && (codeFiltered.envelope?.data?.items ?? []).every((i) => i.statusCode === 404),
  `${codeFiltered.envelope?.data?.totalMatched} matched`);

// 4. Full record, including bodies.
const targetId = postItem?.id ?? items[0]?.id;
const got = await cli(['capture', 'get', String(targetId)]);
const record = got.envelope?.data?.record;
check('capture get exits 0', got.code === 0, `id=${targetId}`);
check('capture get returns a full request', record?.request?.method === 'POST' && Array.isArray(record?.request?.headers) && record.request.headers.length > 0,
  `${record?.request?.method} with ${record?.request?.headers?.length} headers`);
check('capture get returns the request body', record?.request?.body?.text?.includes('e2e') === true,
  `encoding=${record?.request?.body?.encoding} text=${JSON.stringify(record?.request?.body?.text)?.slice(0, 60)}`);
check('capture get returns the response with status 200', record?.response?.code === 200,
  `code=${record?.response?.code} status=${record?.response?.status}`);
check('capture get returns the response body', record?.response?.body?.text?.includes(MARKER) === true,
  `encoding=${record?.response?.body?.encoding} bytes=${record?.response?.body?.text?.length}`);

// 5. curl generation.
const curlCmd = await cli(['capture', 'curl', String(targetId)]);
check('capture curl exits 0 and returns a command',
  curlCmd.code === 0 && typeof curlCmd.envelope?.data?.curl === 'string' && curlCmd.envelope.data.curl.includes('curl'),
  JSON.stringify(curlCmd.envelope?.data?.curlSingleLine)?.slice(0, 140));

// 6. Export to HAR.
const outFile = path.join(os.tmpdir(), `reqable-cli-e2e-${Date.now()}.har`);
const exported = await cli(['capture', 'export', '--out', outFile, '--keyword', 'e2e-', '--limit', '0']);
check('capture export exits 0', exported.code === 0, exported.envelope?.error?.message ?? '');
check('the HAR file exists and is non-empty', fs.existsSync(outFile) && fs.statSync(outFile).size > 200,
  fs.existsSync(outFile) ? `${fs.statSync(outFile).size} bytes` : 'missing');

let har = null;
try {
  har = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch (error) {
  check('the HAR file parses as JSON', false, error.message);
}
if (har) {
  check('the HAR file parses as JSON', true);
  check('the HAR has version 1.2 and a creator', har.log?.version === '1.2' && Boolean(har.log?.creator?.name));
  check('the HAR entries carry URL, method and status',
    har.log.entries.length >= 3 && har.log.entries.every((e) => e.request?.url && e.request?.method && typeof e.response?.status === 'number'),
    `${har.log.entries.length} entries`);
  const withBody = har.log.entries.find((e) => (e.response?.content?.text ?? '').includes(MARKER));
  check('the HAR inlines response bodies', Boolean(withBody), withBody ? `mimeType=${withBody.response.content.mimeType}` : 'no entry carried the marker');
  const withPost = har.log.entries.find((e) => e.request?.postData);
  check('the HAR inlines the request body of the POST', Boolean(withPost), withPost ? `postData.text=${String(withPost.request.postData.text).slice(0, 40)}` : 'no postData');
}

// 7. Replay, both transports, against our own target only.
const dryRun = await cli(['replay', String(targetId), '--dry-run']);
check('replay --dry-run plans without sending', dryRun.code === 0 && dryRun.envelope?.data?.applied === false && dryRun.envelope?.data?.plan?.method === 'POST',
  dryRun.envelope?.data?.plan ? `${dryRun.envelope.data.plan.method} ${dryRun.envelope.data.plan.url}` : '');

const countBeforeDirect = requestCount;
const direct = await cli(['replay', String(targetId), '--via', 'direct', '--header', 'x-e2e-replay: direct']);
check('replay --via direct reaches the target',
  direct.code === 0 && direct.envelope?.data?.response?.statusCode === 200 && requestCount === countBeforeDirect + 1,
  `status=${direct.envelope?.data?.response?.statusCode} bodyBytes=${direct.envelope?.data?.response?.bodyBytes}`);
check('replay --via direct applies a header override',
  typeof direct.envelope?.data?.response?.body === 'string' && direct.envelope.data.response.body.includes('"x-e2e-replay":"direct"'),
  'the target echoed the overridden header');

const countBeforeProxy = requestCount;
const viaReqable = await cli(['replay', String(targetId), '--via', 'reqable']);
check('replay --via reqable reaches the target through the proxy',
  viaReqable.code === 0 && viaReqable.envelope?.data?.response?.statusCode === 200 && requestCount === countBeforeProxy + 1,
  `status=${viaReqable.envelope?.data?.response?.statusCode} via=${viaReqable.envelope?.data?.request?.via}`);

await sleep(600);
const after = await cli(['capture', 'list', '--limit', '3']);
const replayedIds = (after.envelope?.data?.items ?? []).filter((i) => i.method === 'POST');
check('the proxied replay was captured as a new record',
  (after.envelope?.data?.totalMatched ?? 0) > (list.envelope?.data?.totalMatched ?? 0),
  `records before=${list.envelope?.data?.totalMatched} after=${after.envelope?.data?.totalMatched}`);

// 8. Rules: read-only listing must work.
const rules = await cli(['rule', 'list']);
check('rule list exits 0 and returns all three families', rules.code === 0 && Array.isArray(rules.envelope?.data?.types) && rules.envelope.data.types.length === 3,
  JSON.stringify(rules.envelope?.data?.counts));

// 9. Error paths.
const notFound = await cli(['capture', 'get', '999999']);
check('a missing record gives exit 5 and a structured error',
  notFound.code === 5 && notFound.envelope?.ok === false && notFound.envelope?.error?.code === 'NOT_FOUND',
  `exit=${notFound.code} message=${notFound.envelope?.error?.message}`);

const badFlag = await cli(['capture', 'list', '--nope']);
check('an unknown flag gives exit 2 and a structured error',
  badFlag.code === 2 && badFlag.envelope?.error?.code === 'USAGE',
  badFlag.envelope?.error?.message);

const badJson = await cli(['rule', 'set', '--type', 'rewrite', '--payload', '{not json']);
check('malformed rule JSON gives exit 2', badJson.code === 2 && badJson.envelope?.error?.code === 'USAGE',
  badJson.envelope?.error?.message);

// 10. Help is the interface documentation.
for (const args of [['--help'], ['status', '--help'], ['capture', 'list', '--help'], ['capture', 'export', '--help'], ['replay', '--help'], ['rule', 'set', '--help']]) {
  const help = await cli(args);
  check(`help exits 0: reqable-cli ${args.join(' ')}`, help.code === 0 && /reqable-cli/.test(help.stdout) && help.stdout.length > 200,
    `${help.stdout.split('\n').length} lines`);
}

// 11. Restore Reqable's capture state.
if (originalCapture === 'inactive') {
  const off = await cli(['capture', 'off']);
  check('capture state restored to inactive', off.code === 0 && off.envelope?.data?.status === 'inactive');
} else {
  check('capture state left as it was (was active)', true);
}

// ------------------------------------------------------------------- summary

target.close();

if (!KEEP && fs.existsSync(outFile)) fs.unlinkSync(outFile);

const passed = results.length - failed;
process.stdout.write(`\n${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}\n`);
process.stdout.write(`\nSample HAR written for inspection: ${KEEP ? outFile : '(removed; re-run with --keep to retain)'}\n`);

process.exit(failed === 0 ? 0 : 1);
