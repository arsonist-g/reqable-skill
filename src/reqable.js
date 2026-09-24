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
 * Reqable's per-user storage root — Windows only: `%APPDATA%\Reqable`.
 *
 * The Dart source this mirrors (lib/utils/storage.dart:6-33) also names a macOS
 * and a Linux location. Neither has ever been observed from this project, and a
 * path that has not been verified is not worth guessing at: a wrong one would
 * send the user to `--api-port` for a problem that is not about the port.
 * `package.json` declares `os: ["win32"]`, so npm refuses to install elsewhere
 * instead of placing a tool that would look in the wrong directory.
 */
export function reqableRoot() {
  const appData = process.env.APPDATA;
  if (appData && appData.length > 0) return path.join(appData, 'Reqable');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Reqable');
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
 * The Reqable release line this build was written and verified against.
 *
 * Reqable's local API is undocumented and can change between releases, so this
 * package publishes one release line per Reqable line: `main` tracks the newest
 * one, and a `reqable-<line>` branch freezes the last build that worked against
 * an older line. `status` compares this constant with the version actually
 * installed and says so, which is what turns endpoint drift from a mystery into
 * a one-call diagnosis. See README.md, "Publishing and Reqable versions".
 */
export const SUPPORTED_REQABLE = '3.2';
/** The exact release this build was verified against, for the record. */
export const VERIFIED_REQABLE = '3.2.23';

/** `major.minor` of a version string, or null when it is not a version. */
export function versionLine(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  return match ? `${match[1]}.${match[2]}` : null;
}

/** Where Reqable records the version of the app itself. */
export function reqablePreferencesPath() {
  return path.join(reqableRoot(), 'Reqable', 'shared_preferences.json');
}

/** Fallback version source: the app's own event log records a version per event. */
export function reqableEventsPath() {
  return path.join(reqableRoot(), 'config', 'events.json');
}

/**
 * Read the version of the Reqable install on this machine.
 *
 * Neither source is an API: the local API does not report its own version. The
 * app's preferences file carries it directly, and its event log repeats it per
 * event, so the two together cover a fresh install that has written one but not
 * the other. Returns null when neither is readable, which is not an error.
 *
 * Paths are injectable so this can be tested without a Reqable install.
 */
export function detectReqableVersion({
  prefsPath = reqablePreferencesPath(),
  eventsPath = reqableEventsPath(),
} = {}) {
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    const versions = prefs?.['flutter.app_versions'];
    if (Array.isArray(versions) && versions.length > 0) {
      return { version: String(versions[versions.length - 1]), source: 'shared_preferences', path: prefsPath };
    }
  } catch {
    // Fall through to the event log.
  }

  try {
    const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    const seen = (Array.isArray(events?.events) ? events.events : [])
      .map((event) => event?.version)
      .filter((v) => typeof v === 'string' && v.length > 0);
    if (seen.length > 0) {
      return { version: seen[seen.length - 1], source: 'events', path: eventsPath };
    }
  } catch {
    // No version is available; that is a legitimate state, not a failure.
  }

  return null;
}

/**
 * Resolve the API port the way Reqable's own tooling does, and report where the
 * value came from so callers can tell a stale config from an explicit override.
 *
 * The config path is injectable so the discovery rule can be tested against a
 * fixture instead of a real Reqable install. A value that came from the flag is
 * returned as given; validating its type is `ReqableApi`'s job, so there is one
 * place that reports a bad port.
 *
 * `reason` exists so the fallback can be described truthfully. "Reqable's
 * configuration could not be read" is false when the file was read fine and the
 * `proxyPort` inside it was unusable, and that difference is the whole diagnosis:
 * the first means the install is not where this CLI looks for it, the second
 * means Reqable is running on a port it did not write down. Only an integer is
 * accepted, because the reference implementation reads `proxyPort` as an int
 * (lib/config.dart:88) and an unquoted number is what Reqable itself writes.
 *
 * @returns {{port: number, source: 'flag'|'reqable-config'|'default', configPath: string, reason: string}}
 *   reason is 'explicit-flag' | 'from-config' | 'config-unreadable' |
 *   'config-not-json' | 'config-has-no-proxy-port' | 'proxy-port-not-an-integer' |
 *   'proxy-port-out-of-range'
 */
export function resolvePort(explicitPort, configPath = captureConfigPath()) {
  if (explicitPort !== undefined && explicitPort !== null) {
    return { port: Number(explicitPort), source: 'flag', configPath, reason: 'explicit-flag' };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    // A missing config is not an error: it just means the default applies.
    const reason = error instanceof SyntaxError ? 'config-not-json' : 'config-unreadable';
    return { port: DEFAULT_PORT, source: 'default', configPath, reason };
  }

  const port = parsed?.proxyPort;
  if (port === undefined || port === null) {
    return { port: DEFAULT_PORT, source: 'default', configPath, reason: 'config-has-no-proxy-port' };
  }
  if (!Number.isInteger(port)) {
    return { port: DEFAULT_PORT, source: 'default', configPath, reason: 'proxy-port-not-an-integer' };
  }
  if (port <= 0 || port > 65535) {
    return { port: DEFAULT_PORT, source: 'default', configPath, reason: 'proxy-port-out-of-range' };
  }
  return { port, source: 'reqable-config', configPath, reason: 'from-config' };
}

/**
 * Why the port is what it is, as one sentence, or '' when the port came from
 * somewhere trustworthy. Shared by the unreachable error and by `status`, so the
 * two never disagree about the same fallback.
 *
 * The wording follows `reason` instead of lumping every miss into "could not be
 * read": a config that parses but holds an unusable `proxyPort` is a different
 * problem from one this CLI cannot find at all, and only the second one means the
 * install is somewhere else.
 *
 * @returns {string} a leading-space sentence, or '' when there is nothing to say
 */
export function portSourceNote({ port, portSource, portReason, configPath }) {
  if (portSource !== 'default') return '';
  const cause =
    {
      'config-unreadable': `Reqable's configuration could not be read at ${configPath}`,
      'config-not-json': `Reqable's configuration at ${configPath} is not valid JSON`,
      'config-has-no-proxy-port': `Reqable's configuration at ${configPath} carries no proxyPort`,
      'proxy-port-not-an-integer': `the proxyPort in ${configPath} is not a whole number`,
      'proxy-port-out-of-range': `the proxyPort in ${configPath} is outside 1-65535`,
    }[portReason] ?? `Reqable's port could not be determined from ${configPath}`;
  return ` The port ${port} is only a fallback, because ${cause}; if you changed Reqable's port, pass --api-port.`;
}

/**
 * `host:port`, bracketed the way a URL literal needs it.
 *
 * Node's HTTP client accepts a bare `::1` in `host`, but a URL *string* needs
 * `[::1]`, and building one by hand produced `http://::1:9000` — a string the
 * WHATWG parser rejects, which surfaced as a baffling "--proxy expects an
 * absolute URL" error for an `--api-host` that was accepted without complaint.
 */
export function formatHostPort(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * A host without the brackets a URL parser adds around an IPv6 literal.
 *
 * `new URL('http://[::1]:9000').hostname` is `'[::1]'`, and `net.isIP('[::1]')`
 * is 0 — so code asking "is this an IP?" gets "no" for an address that obviously
 * is one, and then puts an IP literal where a host name belongs.
 */
export function bareHost(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}


export class ReqableApi {
  /**
   * @param {{host?: string, port?: number, timeoutMs?: number}} [options]
   */
  constructor({ host, port, timeoutMs } = {}) {
    if (host !== undefined && typeof host !== 'string') {
      throw usageError(`--api-host expects a host name, got ${JSON.stringify(host)}.`);
    }
    if (host !== undefined && host.startsWith('[') && host.endsWith(']')) {
      throw usageError(`--api-host expects a bare address, so drop the brackets: --api-host ${host.slice(1, -1)}`);
    }
    // Range, not just type. Port 0 is falsy, and Node's HTTP client reads a falsy
    // port as "use the default", so accepting it would silently aim the request
    // at port 80 of the API host.
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw usageError(`--api-port expects a whole number between 1 and 65535, got ${JSON.stringify(port)}.`);
    }
    const resolved = resolvePort(port);
    this.host = host || DEFAULT_HOST;
    this.port = resolved.port;
    this.portSource = resolved.source;
    this.portReason = resolved.reason;
    this.configPath = resolved.configPath;
    this.timeoutMs = timeoutMs || REQUEST_TIMEOUT_MS;
  }

  /** Base URL of the local API, for messages and diagnostics. */
  get baseUrl() {
    return `http://${formatHostPort(this.host, this.port)}`;
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
      // The timeout above is an idle timeout, so a host that accepts the
      // connection and then says nothing would sit there for its whole budget.
      // Bound the connect phase separately, which is what the reference client's
      // connect timeout does.
      req.on('socket', (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => {
          req.destroy(new Error(`connecting to ${this.host}:${this.port} timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);
        const stop = () => clearTimeout(timer);
        socket.once('connect', stop);
        socket.once('error', stop);
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    }).catch((err) => {
      // When the port came from the fallback rather than from Reqable's own
      // config, say so and say why: a user who moved Reqable to another port
      // sees "not reachable" here, and the useful fact is that the port was a
      // guess rather than a fact read from Reqable.
      const guessed = portSourceNote(this);
      throw unreachableError(
        `Reqable is not reachable at ${this.baseUrl} (${err.code || err.message}). ` +
          `Start the Reqable application, and check that its capture feature is available.${guessed}`,
        {
          host: this.host,
          port: this.port,
          portSource: this.portSource,
          portReason: this.portReason,
          configPath: this.configPath,
          route,
          syscall: err.code,
        },
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
