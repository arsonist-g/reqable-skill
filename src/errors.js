/**
 * Error taxonomy for reqable-cli.
 *
 * Every failure the CLI can report maps to one stable `code` string and one
 * stable process exit code, so a caller can branch on either without parsing
 * prose. The exit-code table is part of the public interface and is documented
 * in README.md.
 */

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  UNREACHABLE: 3,
  API_ERROR: 4,
  NOT_FOUND: 5,
  CONFIRMATION_REQUIRED: 6,
};

export class CliError extends Error {
  /**
   * @param {string} code stable machine-readable error code
   * @param {string} message human-readable one-liner
   * @param {object} [options]
   * @param {number} [options.exitCode] process exit code
   * @param {object} [options.details] extra structured context
   * @param {Error}  [options.cause]
   */
  constructor(code, message, { exitCode = EXIT.INTERNAL, details, cause } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export const usageError = (message, details) =>
  new CliError('USAGE', message, { exitCode: EXIT.USAGE, details });

export const unreachableError = (message, details, cause) =>
  new CliError('REQABLE_UNREACHABLE', message, {
    exitCode: EXIT.UNREACHABLE,
    details,
    cause,
  });

export const apiError = (message, details, cause) =>
  new CliError('REQABLE_API_ERROR', message, {
    exitCode: EXIT.API_ERROR,
    details,
    cause,
  });

export const notFoundError = (message, details) =>
  new CliError('NOT_FOUND', message, { exitCode: EXIT.NOT_FOUND, details });

export const confirmationError = (message, details) =>
  new CliError('CONFIRMATION_REQUIRED', message, {
    exitCode: EXIT.CONFIRMATION_REQUIRED,
    details,
  });
