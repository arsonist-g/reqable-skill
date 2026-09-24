/**
 * Filter construction.
 *
 * Reqable's `/capture/live/filter` accepts a list of typed filter objects which
 * it combines with logical AND. The filter vocabulary is fixed on Reqable's
 * side (lib/tools/capture/live.dart:536-550):
 *
 *   keyword { pattern, caseSensitive?, regex? }
 *   url     { urls: [] }
 *   host    { hosts: [] }
 *   ip      { ips: [] }
 *   method  { methods: [] }
 *   code    { codes: [] }
 *   application { name?, id?, pid? }
 */

import { usageError } from './errors.js';

/**
 * Flag definitions shared by commands that filter capture records.
 * Kept in one place so `capture list` and `capture export` cannot drift apart.
 */
export const filterFlags = {
  host: { type: 'list', description: 'Match records by exact request host. Repeat or comma-separate.' },
  url: { type: 'list', description: 'Match records by exact request URL. Repeat or comma-separate.' },
  method: { type: 'list', description: 'Match records by HTTP method, e.g. GET or POST.' },
  code: { type: 'list', description: 'Match records by response status code, e.g. 200,404.' },
  keyword: { type: 'string', description: 'Match records by a keyword found anywhere in URL, headers or bodies.' },
  regex: { type: 'boolean', description: 'Treat --keyword as a regular expression.' },
  'case-sensitive': { type: 'boolean', description: 'Make --keyword matching case-sensitive.' },
  ip: { type: 'list', description: 'Match records by exact remote IP address.' },
  app: { type: 'string', description: 'Match records by client application name substring.' },
  pid: { type: 'number', description: 'Match records by client application process id.' },
};

/**
 * Translate parsed CLI flags into Reqable's filter payload.
 * @returns {Array<object>} filters, combined by Reqable with AND
 */
export function buildFilters(values) {
  const filters = [];

  if (values.host?.length) filters.push({ type: 'host', hosts: values.host });
  if (values.url?.length) filters.push({ type: 'url', urls: values.url });
  if (values.ip?.length) filters.push({ type: 'ip', ips: values.ip });

  if (values.method?.length) {
    filters.push({ type: 'method', methods: values.method.map((m) => String(m).toUpperCase()) });
  }

  if (values.code?.length) {
    const codes = values.code.map((c) => Number(c));
    if (codes.some((c) => !Number.isInteger(c))) {
      throw usageError('--code expects integer status codes, e.g. --code 200,404');
    }
    filters.push({ type: 'code', codes });
  }

  if (values.keyword !== undefined) {
    const filter = { type: 'keyword', pattern: values.keyword };
    if (values.regex) filter.regex = true;
    if (values['case-sensitive']) filter.caseSensitive = true;
    filters.push(filter);
  }

  if (values.app !== undefined || values.pid !== undefined) {
    const filter = { type: 'application' };
    if (values.app !== undefined) filter.name = values.app;
    if (values.pid !== undefined) filter.pid = values.pid;
    filters.push(filter);
  }

  return filters;
}

/** Human-readable description of the active filters, for the response envelope. */
export function describeFilters(filters) {
  if (filters.length === 0) return 'all retained records';
  return filters.map((f) => f.type).join(' AND ');
}
