/**
 * Record shaping: turning Reqable's raw capture records into the stable shapes
 * reqable-cli promises, plus HAR 1.2 export.
 *
 * The raw record layout is documented in docs/endpoints.md and mirrors the
 * output schema of `capture_live_get_by_id` in the reqable-mcp-server source
 * (lib/tools/capture/live.dart:980-1030): protocol, id, uid, url, connection,
 * application, request, response, messages.
 */

import fs from 'node:fs';

/**
 * Compact, stable view of one record. Safe to print in a list: no bodies.
 */
export function summarize(record) {
  const url = safeUrl(record?.url);
  const responseBody = record?.response?.body ?? null;
  const requestBody = record?.request?.body ?? null;

  return {
    id: record?.id ?? null,
    uid: record?.uid ?? null,
    protocol: record?.protocol ?? null,
    url: record?.url ?? null,
    host: url?.host ?? null,
    path: url ? `${url.pathname}${url.search}` : (record?.request?.path ?? null),
    method: record?.request?.method ?? null,
    statusCode: record?.response?.code ?? null,
    statusText: record?.response?.status ?? null,
    responseMime: responseBody?.mime ?? null,
    requestBodyBytes: bodyByteLength(requestBody),
    responseBodyBytes: bodyByteLength(responseBody),
    application: record?.application?.name ?? null,
    startedAt: record?.connection?.timestamp ?? null,
    remote: record?.connection?.remote?.ip
      ? `${record.connection.remote.ip}:${record.connection.remote.port}`
      : null,
  };
}

/** Returns the raw record unchanged; kept as a seam for future normalisation. */
export function fullRecord(record) {
  return record ?? null;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Byte length of a body payload.
 *
 * Reqable reports a body as { text, mime?, encoding } where encoding is one of
 * `utf8`, `base64` or `file`. For `file`, `text` is a path on disk, so the size
 * comes from the file itself. For `base64`, the padding characters are not
 * payload, so they are subtracted rather than rounded away.
 */
export function bodyByteLength(body) {
  if (!body || typeof body.text !== 'string') return null;
  if (body.encoding === 'base64') {
    const padding = /=*$/.exec(body.text)?.[0].length ?? 0;
    return Math.floor((body.text.length * 3) / 4) - padding;
  }
  if (body.encoding === 'file') {
    try {
      return fs.statSync(body.text).size;
    } catch {
      return null;
    }
  }
  return Buffer.byteLength(body.text, 'utf8');
}

/** True when a body payload exists but its content cannot be produced. */
function bodyUnreadable(body) {
  if (!body || typeof body.text !== 'string') return false;
  if (body.encoding !== 'file') return false;
  try {
    fs.statSync(body.text);
    return false;
  } catch {
    return true;
  }
}

/**
 * Materialise a body payload for export.
 *
 * @returns {{text: string, encoding?: 'base64', size: number, mimeType: string|null}|null}
 *   null when there is no body, or when a body stored on disk can no longer be
 *   read. The caller distinguishes those two cases with `bodyUnreadable`.
 */
export function bodyContent(body) {
  if (!body) return null;
  const mimeType = body.mime ?? null;

  if (body.encoding === 'base64') {
    return { text: body.text, encoding: 'base64', size: bodyByteLength(body), mimeType };
  }
  if (body.encoding === 'file') {
    try {
      const buffer = fs.readFileSync(body.text);
      const asText = buffer.toString('utf8');
      const isBinary = Buffer.from(asText, 'utf8').equals(buffer) === false;
      return isBinary
        ? { text: buffer.toString('base64'), encoding: 'base64', size: buffer.length, mimeType }
        : { text: asText, size: buffer.length, mimeType };
    } catch {
      return null;
    }
  }
  return { text: body.text, size: Buffer.byteLength(body.text, 'utf8'), mimeType };
}

function parseQuery(search) {
  const out = [];
  if (!search || search.length < 2) return out;
  for (const pair of search.slice(1).split('&')) {
    if (pair === '') continue;
    const idx = pair.indexOf('=');
    const name = idx === -1 ? pair : pair.slice(0, idx);
    const value = idx === -1 ? '' : pair.slice(idx + 1);
    // URL query strings are not form bodies, so `+` is a literal plus sign and
    // must not be turned into a space. `request.url` above keeps it as `+`, and
    // the two must agree.
    out.push({ name: decodeSafe(name), value: decodeSafe(value) });
  }
  return out;
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Convert a record into one HAR 1.2 entry.
 *
 * Timings are reported as -1 for every phase. Reqable's local API exposes no
 * per-phase timing for a live record, so inventing numbers would be worse than
 * declaring them unavailable, which is exactly what -1 means in HAR 1.2.
 *
 * A body that could not be read is reported with `size: -1`, HAR's other value
 * for "unknown", plus a comment. Reporting it as size 0 would claim the response
 * had an empty body, which is a different and wrong fact.
 */
export function harEntry(record) {
  const url = safeUrl(record?.url);
  const request = record?.request ?? {};
  const response = record?.response ?? null;

  const requestContent = bodyContent(request.body);
  const responseContent = response ? bodyContent(response.body) : null;
  const requestUnreadable = bodyUnreadable(request.body);
  const responseUnreadable = response ? bodyUnreadable(response.body) : false;

  const requestHeaders = headerList(request.headers);
  const responseHeaders = headerList(response?.headers);

  const entry = {
    startedDateTime: record?.connection?.timestamp ?? new Date(0).toISOString(),
    time: -1,
    request: {
      method: request.method ?? 'GET',
      url: record?.url ?? '',
      httpVersion: request.protocol ?? '',
      cookies: [],
      headers: requestHeaders,
      queryString: parseQuery(url?.search ?? ''),
      headersSize: -1,
      bodySize: requestContent ? requestContent.size : (requestUnreadable ? -1 : 0),
    },
    response: {
      status: response?.code ?? 0,
      statusText: response?.status ?? '',
      httpVersion: response?.protocol ?? '',
      cookies: [],
      headers: responseHeaders,
      content: responseContent
        ? {
            size: responseContent.size,
            mimeType: responseContent.mimeType ?? '',
            ...(responseContent.encoding ? { encoding: 'base64' } : {}),
            text: responseContent.text,
          }
        : {
            size: responseUnreadable ? -1 : 0,
            mimeType: response?.body?.mime ?? '',
          },
      redirectURL: findHeader(responseHeaders, 'location') ?? '',
      headersSize: -1,
      bodySize: responseContent ? responseContent.size : (responseUnreadable ? -1 : 0),
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: -1,
      wait: -1,
      receive: -1,
      ssl: -1,
    },
  };

  if (responseUnreadable) {
    entry.response.content.comment = 'the recorded response body could not be read from disk';
  }

  if (requestContent) {
    entry.request.postData = {
      mimeType: requestContent.mimeType ?? findHeader(requestHeaders, 'content-type') ?? '',
      text: requestContent.text,
      // HAR 1.2's postData has no `encoding` field, so a binary body is marked
      // here instead of being silently presented as text.
      ...(requestContent.encoding ? { comment: 'binary request body, base64-encoded in text' } : {}),
    };
  } else if (requestUnreadable) {
    entry.request.postData = {
      mimeType: request?.body?.mime ?? '',
      text: '',
      comment: 'the recorded request body could not be read from disk',
    };
  }

  return entry;
}

/**
 * Build a complete HAR 1.2 document.
 *
 * @returns {{document: object, unreadableBodies: number}}
 *   The count is returned beside the document rather than inside it, so the file
 *   stays a valid HAR while the caller can still tell whether anything was lost.
 */
export function harDocument(records) {
  const entries = records.map(harEntry);
  const unreadableBodies = records.reduce(
    (total, record) =>
      total +
      (bodyUnreadable(record?.request?.body) ? 1 : 0) +
      (bodyUnreadable(record?.response?.body) ? 1 : 0),
    0,
  );

  return {
    document: {
      log: {
        version: '1.2',
        creator: { name: 'reqable-cli', version: '1.0.0' },
        entries,
      },
    },
    unreadableBodies,
  };
}

function headerList(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((h) => h && typeof h.name === 'string')
    .map((h) => ({ name: h.name, value: h.value ?? '' }));
}

function findHeader(headers, name) {
  const lower = name.toLowerCase();
  const hit = headers.find((h) => h.name.toLowerCase() === lower);
  return hit ? hit.value : null;
}

/**
 * Collapse the cURL command Reqable generates into one POSIX-safe line.
 *
 * Reqable emits Windows cmd continuations (`^` at end of line). Agents usually
 * run in a POSIX shell, where that syntax is a syntax error, so the single-line
 * form joins the fragments. Nothing else is touched: collapsing runs of spaces
 * inside a quoted header value or body would silently change the bytes the
 * command sends.
 */
export function curlToSingleLine(curlText) {
  if (typeof curlText !== 'string') return null;
  return curlText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]*\^[ \t]*\n[ \t]*/g, ' ')
    .replace(/[ \t]*\\\n[ \t]*/g, ' ')
    .trim();
}
