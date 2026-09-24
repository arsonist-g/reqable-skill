/**
 * `reqable-cli status` — one call that answers "is Reqable usable right now?".
 *
 * Unlike every other command, `status` does not fail when Reqable is down: its
 * whole job is to report the state, so it always exits 0 and says
 * `reachable: false` together with the reason. That makes it the right first
 * call for an agent, which then needs no exit-code branching to diagnose.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import { certificateDir, DEFAULT_HOST } from '../reqable.js';

/** Switches worth reporting, with the endpoint that reveals each one. */
const SWITCHES = [
  ['sslProxying', 'sslProxyingActive'],
  ['accessControl', 'accessControlActive'],
  ['networkThrottling', 'networkThrottlingActive'],
  ['secondaryProxy', 'secondaryProxyActive'],
];

export async function statusCommand(api) {
  const data = {
    reachable: false,
    host: api.host ?? DEFAULT_HOST,
    port: api.port,
    portSource: api.portSource,
    configPath: api.configPath,
    capture: { status: null },
    switches: {},
    certificate: describeCertificate(),
    errors: [],
  };

  try {
    const captureStatus = await api.captureStatus();
    data.reachable = true;
    data.capture.status = captureStatus?.status ?? null;
  } catch (error) {
    data.errors.push(describeError(error));
    return { data: { ...data, hint: unreachableHint(error) } };
  }

  for (const [label, method] of SWITCHES) {
    try {
      const payload = await api[method]();
      const profile = payload?.profile ?? null;
      data.switches[label] = {
        active: profile !== null,
        profile,
      };
    } catch (error) {
      data.switches[label] = { active: null, error: describeError(error) };
    }
  }

  return { data };
}

export const statusHelp = {
  command: 'status',
  summary: 'report whether Reqable is reachable and which capture features are active',
  options: [
    { name: '--api-host <host>', description: 'Reqable API host.', default: DEFAULT_HOST },
    { name: '--api-port <port>', description: 'Reqable API port. Defaults to the port in Reqable\'s own config, else 9000.' },
    { name: '--pretty', description: 'Indent the JSON output for human reading.' },
    { name: '--help', description: 'Show this help and exit 0.' },
  ],
  notes: `Always exits 0: "Reqable is down" is a result, not a failure. Read data.reachable.
Also reports the capture CA certificate (path, subject, validity) from Reqable's
certificate directory, so you can tell whether the CA is installed and current.`,
  examples: ['reqable-cli status', 'reqable-cli status --pretty'],
};

function describeCertificate() {
  const dir = certificateDir();
  const result = { directory: dir, authority: null, files: [] };

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      result.files.push({ name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      // ignore unreadable entries
    }
  }

  const caPath = path.join(dir, 'reqable-root.crt');
  try {
    const pem = fs.readFileSync(caPath, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    const validTo = new Date(cert.validTo);
    result.authority = {
      path: caPath,
      subject: cert.subject.replace(/\n/g, ', ').trim(),
      issuer: cert.issuer.replace(/\n/g, ', ').trim(),
      validFrom: new Date(cert.validFrom).toISOString(),
      validTo: validTo.toISOString(),
      expired: validTo.getTime() < Date.now(),
      fingerprint256: cert.fingerprint256,
    };
  } catch {
    // No CA material yet, or it is not a readable PEM: leave authority null.
  }

  return result;
}

function describeError(error) {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: error?.message ?? String(error) };
}

function unreachableHint(error) {
  if (error instanceof CliError && error.code === 'REQABLE_UNREACHABLE') {
    return 'Start the Reqable application. Its local API is served by the app process, so it does not exist while Reqable is closed.';
  }
  return 'Reqable answered, but the API call failed. Check Reqable\'s version and the capture feature state.';
}
