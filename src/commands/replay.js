/**
 * `reqable-cli replay <id>` — re-issue a captured request.
 *
 * Two transports:
 *   --via direct   (default) talk to the origin host directly with Node's own
 *                  HTTP stack; TLS is verified against Node's CA store.
 *   --via reqable  send through Reqable's proxy so the replay becomes a new
 *                  captured record. For https this means Reqable MITMs the
 *                  connection, so its CA must be trusted by the client; the CLI
 *                  refuses to skip verification unless --insecure is given.
 *
 * Safety: a replay is a real outbound request to a real host. The command never
 * rewrites the target unless you explicitly pass --url, and it has no retry
 * logic, so a replay cannot silently fan out.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';

import { apiError, usageError } from '../errors.js';

const DEFAULT_MAX_BODY = 8192;
const DEFAULT_TIMEOUT_MS = 30000;

/** Headers recomputed by the HTTP stack, or meaningless outside a proxy hop. */
const DROP_HEADERS = new Set([
  'host',
  'content-length',
  'proxy-connection',
  'connection',
  'transfer-encoding',
]);

export async function replayCommand(api, values, positionals) {
  const id = parseId(positionals[0]);
  const record = await api.getRecord(id);

  const plan = buildPlan(record, values, api);

  if (values['dry-run']) {
    return {
      data: {
        id,
        applied: false,
        plan: { ...plan, body: describeBody(plan.body) },
      },
    };
  }

  const started = Date.now();
  const response = await send(plan, values);
  const durationMs = Date.now() - started;

  return {
    data: {
      id,
      applied: true,
      request: {
        method: plan.method,
        url: plan.url,
        via: plan.via,
        proxy: plan.proxy ?? null,
        headers: plan.headers,
        bodyBytes: plan.body ? plan.body.length : 0,
      },
      response: formatResponse(response, values),
      durationMs,
    },
  };
}

// -- request construction ---------------------------------------------------

function buildPlan(record, values, api) {
  const url = values.url ?? record?.url;
  if (!url) throw usageError('The record has no URL to replay.');

  const method = (values.method ?? record?.request?.method ?? 'GET').toUpperCase();

  const headers = [];
  for (const header of record?.request?.headers ?? []) {
    if (!header || typeof header.name !== 'string') continue;
    if (DROP_HEADERS.has(header.name.toLowerCase())) continue;
    headers.push({ name: header.name, value: header.value ?? '' });
  }
  for (const override of values.header ?? []) {
    const idx = override.indexOf(':');
    if (idx <= 0) throw usageError(`--header expects "Name: value", got "${override}"`);
    const name = override.slice(0, idx).trim();
    const value = override.slice(idx + 1).trim();
    const existing = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) headers[existing] = { name, value };
    else headers.push({ name, value });
  }

  const body = buildBody(record, values);

  const via = values.via ?? 'direct';
  if (via !== 'direct' && via !== 'reqable') {
    throw usageError('--via expects "direct" or "reqable".');
  }

  const proxy = via === 'reqable' ? values.proxy ?? `http://${api.host}:${api.port}` : null;

  return { method, url, headers, body, via, proxy };
}

function buildBody(record, values) {
  if (values.body !== undefined) return Buffer.from(values.body, 'utf8');

  const body = record?.request?.body;
  if (!body || typeof body.text !== 'string') return null;

  if (body.encoding === 'base64') return Buffer.from(body.text, 'base64');
  if (body.encoding === 'file') {
    try {
      return fs.readFileSync(body.text);
    } catch {
      throw usageError(`The captured body file is no longer readable: ${body.text}`);
    }
  }
  return Buffer.from(body.text, 'utf8');
}

function describeBody(body) {
  return body
    ? { bytes: body.length, preview: body.subarray(0, 512).toString('utf8') }
    : null;
}

// -- transport --------------------------------------------------------------

function send(plan, values) {
  const timeoutMs = values.timeout ?? DEFAULT_TIMEOUT_MS;
  if (plan.via === 'direct') return sendDirect(plan, values, timeoutMs);
  return sendViaProxy(plan, values, timeoutMs);
}

function sendDirect(plan, values, timeoutMs) {
  const target = new URL(plan.url);
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? https : http;

  const options = {
    method: plan.method,
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers: headerObject(plan.headers),
    ...(isHttps && values.insecure ? { rejectUnauthorized: false } : {}),
  };

  return perform(mod, options, plan.body, timeoutMs);
}

/**
 * Open a connection that is used for exactly one proxy request.
 *
 * Reqable serves its local API and its capture proxy on the same port, and it
 * decides what a connection is for when that connection is first used. Node 19+
 * keeps client sockets alive by default, so a replay would reuse the very socket
 * this process already used for API calls — and Reqable would read the proxy
 * request as one more API call, answer it from its internal server and never
 * forward it. A one-shot connection removes the ambiguity.
 */
const ONE_SHOT = false;

function sendViaProxy(plan, values, timeoutMs) {
  const proxy = new URL(plan.proxy);
  const target = new URL(plan.url);
  const headers = headerObject(plan.headers);
  headers.host = target.host;

  if (target.protocol === 'http:') {
    // Plain HTTP through a proxy: the request line carries the absolute URL.
    return perform(
      http,
      {
        method: plan.method,
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        path: plan.url,
        headers,
        agent: ONE_SHOT,
      },
      plan.body,
      timeoutMs,
    );
  }

  if (target.protocol !== 'https:') {
    throw usageError(`Unsupported URL scheme for replay: ${target.protocol}`);
  }

  // HTTPS through a proxy: CONNECT, then TLS to the proxy-issued certificate.
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (options, callback) => {
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { host: `${target.hostname}:${target.port || 443}` },
    });
    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        callback(new Error(`Proxy refused CONNECT with status ${res.statusCode}`));
        socket.destroy();
        return;
      }
      const secure = tls.connect(
        {
          socket,
          servername: target.hostname,
          // The proxy MITMs this connection, so the presented leaf certificate
          // is Reqable's. Verification can only pass if that CA is trusted by
          // this process; otherwise the caller must opt in with --insecure.
          rejectUnauthorized: !values.insecure,
        },
        () => callback(null, secure),
      );
      secure.once('error', callback);
    });
    connectReq.once('error', callback);
    connectReq.end();
  };

  return perform(
    https,
    {
      method: plan.method,
      host: target.hostname,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      headers,
      agent,
    },
    plan.body,
    timeoutMs,
  );
}

function perform(mod, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          httpVersion: res.httpVersion,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          buffer: decompress(Buffer.concat(chunks), res.headers['content-encoding']),
        }),
      );
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`replay timed out after ${timeoutMs}ms`)));
    req.on('error', (error) => {
      reject(
        apiError(`Replay failed: ${error.message}`, {
          code: error.code,
          target: `${options.host ?? options.hostname}:${options.port}`,
        }, error),
      );
    });
    if (body) req.write(body);
    req.end();
  });
}

function headerObject(headers) {
  const out = {};
  for (const header of headers) out[header.name] = header.value;
  return out;
}

function decompress(buffer, encoding) {
  if (!encoding) return buffer;
  const value = String(encoding).toLowerCase();
  try {
    if (value === 'gzip' || value === 'x-gzip') return zlib.gunzipSync(buffer);
    if (value === 'deflate') return zlib.inflateSync(buffer);
    if (value === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // Fall through: hand back the raw bytes rather than losing the response.
  }
  return buffer;
}

// -- response shaping -------------------------------------------------------

function formatResponse(response, values) {
  const maxBody = values['max-body'] ?? DEFAULT_MAX_BODY;
  const full = values.full === true;

  const limit = full ? response.buffer.length : Math.min(maxBody, response.buffer.length);
  const slice = response.buffer.subarray(0, limit);
  const text = slice.toString('utf8');
  const lossy = Buffer.from(text, 'utf8').equals(slice) === false;

  const headers = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    headers.push({ name: response.rawHeaders[i], value: response.rawHeaders[i + 1] });
  }

  return {
    statusCode: response.statusCode,
    statusText: response.statusMessage,
    httpVersion: response.httpVersion,
    headers,
    bodyBytes: response.buffer.length,
    truncated: limit < response.buffer.length,
    ...(lossy
      ? { bodyBase64: slice.toString('base64'), bodyEncoding: 'base64' }
      : { body: text, bodyEncoding: 'utf8' }),
  };
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) {
    throw usageError(`Expected a numeric capture record id, got "${raw}". Use "reqable-cli capture list" to see valid ids.`);
  }
  return id;
}

export const replayHelp = {
  command: 'replay <id>',
  summary: 're-send a captured request and report the response',
  options: [
    { name: '--via <t>', description: 'Transport. direct = straight to the origin; reqable = through Reqable\'s proxy so the replay is captured again.', values: ['direct', 'reqable'], default: 'direct' },
    { name: '--proxy <url>', description: 'Proxy URL. Defaults to Reqable\'s own proxy when --via reqable.' },
    { name: '--header <h>', description: 'Set a header as "Name: value". Repeatable, and a header of the same name is replaced rather than duplicated.' },
    { name: '--method <m>', description: 'Override the HTTP method.' },
    { name: '--url <url>', description: 'Send to a different URL. Nothing is rewritten implicitly.' },
    { name: '--body <text>', description: 'Replace the request body with this text.' },
    { name: '--timeout <ms>', description: 'Give up after this long.', default: String(DEFAULT_TIMEOUT_MS) },
    { name: '--max-body <bytes>', description: 'Max response body bytes to include.', default: String(DEFAULT_MAX_BODY) },
    { name: '--full', description: 'Include the whole response body.' },
    { name: '--insecure', description: 'Skip TLS verification. Needed for https through Reqable, which intercepts with its own CA.' },
    { name: '--dry-run', description: 'Show the request that would be sent, without sending it.' },
    { name: '--api-port <p>', description: 'Reqable API port.' },
    { name: '--pretty', description: 'Indent the JSON output.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `This sends a real request to a real host. Only replay traffic you are
authorised to send: a replay can create server-side effects (a write, a payment,
a message) exactly as the original request did.

Headers that the HTTP stack must recompute (host, content-length, connection,
transfer-encoding) are dropped from the captured request and rebuilt. The body
is resent byte-for-byte. There is no automatic retry.`,
  examples: [
    'reqable-cli replay 12 --dry-run',
    'reqable-cli replay 12 --via reqable --insecure',
    'reqable-cli replay 12 --header "Authorization: Bearer $TOKEN" --method POST',
  ],
};
