/**
 * Client for Reqable's local HTTP API.
 *
 * The API is served by the running Reqable application itself: it listens on
 * the same TCP port as the capture proxy and answers plain HTTP with JSON. No
 * authentication is involved — see docs/endpoints.md for the evidence, which
 * is extracted from the reqable-mcp-server Dart source and confirmed against a
 * live instance.
 *
 * Only endpoints that reqable-cli actually calls are implemented here. Anything
 * absent is deliberate: in particular `/proxy/set` is never called, because it
 * flips the machine's system proxy setting.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apiError, notFoundError, unreachableError, usageError } from './errors.js';

/** Connect timeout, matching the Dart reference client (lib/api/client.dart:8). */
const CONNECT_TIMEOUT_MS = 5000;
/** Whole-request timeout, matching the Dart reference client (lib/api/client.dart:9). */
const REQUEST_TIMEOUT_MS = 30000;

export const DEFAULT_HOST = '127.0.0.1';
/** Fallback when Reqable's config cannot be read (lib/config.dart:_kDefaultPort). */
export const DEFAULT_PORT = 9000;

/**
 * Reqable's per-user storage root.
 *
 * Mirrors Storage.rootPath in the Dart source (lib/utils/storage.dart:6-33):
 * Windows uses %APPDATA%\Reqable, macOS uses ~/Library/Application Support/
 * com.reqable.macosx, Linux uses ~/.local/share/com.reqable.linux.
 */
export function reqableRoot() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) return path.join(appData, 'Reqable');
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Reqable');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'com.reqable.macosx');
  }
  return path.join(os.homedir(), '.local', 'share', 'com.reqable.linux');
}

/** Path of the config file that holds `proxyPort` (lib/config.dart:_resolveAppPort). */
export function captureConfigPath() {
  return path.join(reqableRoot(), 'config', 'capture_config');
}

/** Directory holding the generated CA material (certificate/reqable-root.crt). */
export function certificateDir() {
  return path.join(reqableRoot(), 'certificate');
}

/**
 * Resolve the API port the way Reqable's own tooling does, and report where the
 * value came from so callers can tell a stale config from an explicit override.
 *
 * @returns {{port: number, source: 'flag'|'reqable-config'|'default', configPath: string}}
 */
export function resolvePort(explicitPort) {
  const configPath = captureConfigPath();
  if (explicitPort !== undefined && explicitPort !== null) {
    return { port: Number(explicitPort), source: 'flag', configPath };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const port = parsed?.proxyPort;
    if (Number.isInteger(port) && port > 0 && port < 65535) {
      return { port, source: 'reqable-config', configPath };
    }
  } catch {
    // Missing or unreadable config is not an error: fall back to the default.
  }
  return { port: DEFAULT_PORT, source: 'default', configPath };
}

export class ReqableApi {
  /**
   * @param {{host?: string, port?: number, timeoutMs?: number}} [options]
   */
  constructor({ host, port, timeoutMs } = {}) {
    if (host !== undefined && typeof host !== 'string') {
      throw usageError(`--api-host expects a host name, got ${JSON.stringify(host)}.`);
    }
    if (port !== undefined && !Number.isInteger(port)) {
      throw usageError(`--api-port expects an integer, got ${JSON.stringify(port)}.`);
    }
    const resolved = resolvePort(port);
    this.host = host || DEFAULT_HOST;
    this.port = resolved.port;
    this.portSource = resolved.source;
    this.configPath = resolved.configPath;
    this.timeoutMs = timeoutMs || REQUEST_TIMEOUT_MS;
  }

  /** Base URL of the local API, for messages and diagnostics. */
  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Issue one request against the local API.
   *
   * POSTs always carry a JSON body and a JSON content type. That is not
   * cosmetic: Reqable's own router only acts on some POST routes when the
   * request declares a JSON content type, so a body-less POST is unreliable.
   */
  async request(method, route, payload) {
    const isPost = method === 'POST';
    const body = isPost ? JSON.stringify(payload ?? {}) : undefined;

    const options = {
      host: this.host,
      port: this.port,
      path: route,
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'reqable-cli/1.0.0',
        ...(isPost
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {}),
      },
    };

    const { statusCode, text } = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`request to ${route} timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    }).catch((err) => {
      throw unreachableError(
        `Reqable is not reachable at ${this.baseUrl} (${err.code || err.message}). ` +
          'Start the Reqable application, and check that its capture feature is available.',
        { host: this.host, port: this.port, portSource: this.portSource, configPath: this.configPath, route, syscall: err.code },
        err,
      );
    });

    const parsed = parseJsonOrNull(text);

    // Some routes answer with plain text rather than JSON:
    // /capture/live/generate/curl returns the cURL command as text/plain. Hand
    // the raw body back instead of collapsing it to null, so those routes stay
    // usable. An empty body still resolves to null.
    if (statusCode >= 200 && statusCode < 300) {
      return parsed === null && text.length > 0 ? text : parsed;
    }

    const message = parsed?.message || text || `HTTP ${statusCode}`;
    if (statusCode === 404) {
      throw notFoundError(message, { route, status: statusCode, method });
    }
    throw apiError(`${method} ${route} failed: ${message}`, {
      route,
      method,
      status: statusCode,
      message,
    });
  }

  get(route) {
    return this.request('GET', route);
  }

  post(route, payload) {
    return this.request('POST', route, payload);
  }

  // -- capture (live) -------------------------------------------------------

  captureStatus() {
    return this.get('/capture/live/status');
  }

  captureOn() {
    return this.post('/capture/live/on');
  }

  captureOff() {
    return this.post('/capture/live/off');
  }

  /** Filter retained records. Returns an array of numeric record IDs. */
  filterRecords(filters) {
    return this.post('/capture/live/filter', { filters: filters ?? [] }).then((r) => {
      if (Array.isArray(r)) return r;
      if (Array.isArray(r?.items)) return r.items;
      return [];
    });
  }

  getRecord(id) {
    return this.post('/capture/live/get', { id: Number(id) });
  }

  clearRecords() {
    return this.post('/capture/live/clear');
  }

  generateCurl(id) {
    return this.post('/capture/live/generate/curl', { id: Number(id) });
  }

  // -- capture feature switches --------------------------------------------

  sslProxyingActive() {
    return this.get('/capture/ssl-proxying/get-active');
  }

  accessControlActive() {
    return this.get('/capture/access-control/get-active');
  }

  networkThrottlingActive() {
    return this.get('/capture/network-throttling/get-active');
  }

  secondaryProxyActive() {
    return this.get('/capture/secondary-proxy/get-active');
  }

  // -- rules ---------------------------------------------------------------

  listRules(type) {
    return this.get(`/capture/${type}/list`);
  }

  /**
   * Toggle individual rules of one type.
   *
   * The payload is `{ ids: [...], enabled }` — not `{ id }`. The Dart source
   * sends the whole argument map to `/capture/<type>/enable|disable`
   * (lib/tools/capture/breakpoint.dart:427-432), and its schema requires the
   * `ids` array and the `enabled` flag, with `enabled` also picking the route.
   */
  setRulesEnabled(type, ids, enabled) {
    return this.post(`/capture/${type}/${enabled ? 'enable' : 'disable'}`, {
      ids: ids.map(String),
      enabled,
    });
  }

  /** Turn a whole capture feature on or off, e.g. breakpoints or rewrites. */
  setRuleFeatureEnabled(type, enabled) {
    return this.post(`/capture/${type}/${enabled ? 'on' : 'off'}`);
  }

  /**
   * Create one rule. The payload is forwarded to Reqable verbatim, exactly as
   * the MCP tool does (`jsonMap: args`), so the field names are Reqable's own.
   */
  createRule(type, payload) {
    return this.post(`/capture/${type}/create`, payload);
  }
}

export const RULE_TYPES = ['breakpoint', 'rewrite', 'script'];

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
