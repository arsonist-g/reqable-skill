/**
 * `reqable-cli skill …` — install the agent-facing skill that ships with this
 * package into a skills directory.
 *
 * This is the one entry that has nothing to do with Reqable's API. It exists
 * because the skill and the CLI ship together: an agent that has the CLI should
 * be able to write the matching skill, instead of being handed a copy by hand.
 * The traffic-facing surface stays at ten entries (`spec/cli-contract.md` §1);
 * installation is a setup action, documented in `references/install-and-config.md`
 * rather than in the agent's working set.
 *
 * What it copies is fixed, and its absence is treated as a packaging defect
 * rather than something to work around: if a published tarball is missing
 * `references/`, this command says so instead of installing a skill that will
 * silently mislead its reader.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliError, confirmationError, usageError } from '../errors.js';

/** Directory name the skill takes, matching the `name` in its frontmatter. */
const SKILL_NAME = 'reqable-cli';

/** Files the skill consists of, relative to the package root. The order is the report order. */
const SKILL_FILES = [
  'SKILL.md',
  'skill-zh.md',
  'references/install-and-config.md',
  'references/install-and-config-zh.md',
  'references/errors.md',
  'references/errors-zh.md',
];

/** Where agent runtimes look for skills by default. */
function defaultSkillsDir() {
  return path.join(os.homedir(), '.agents', 'skills');
}

/**
 * What is at a path: `{ kind: 'absent'|'directory'|'file'|'other', error?: string }`.
 *
 * `follow` decides between stat and lstat, and the two callers need opposite
 * answers. A skills directory kept in a dotfiles repository is normally a
 * symlink, so `--dir` must be inspected with `statSync` — refusing one because
 * "it is not a directory" would be wrong and would reject a layout that used to
 * work. The target path is inspected with `lstatSync`, where a link must be seen
 * as itself so it can be replaced rather than descended into.
 *
 * `error` carries the errno when the path could not be inspected at all
 * (ENOTDIR, EACCES, ELOOP), which the previous catch-all reported as `absent`.
 * That is the difference between "nothing is there yet" and "you pointed at
 * something unusable", and only one of them is safe to write to.
 */
function inspectPath(target, { follow = true } = {}) {
  try {
    const stat = (follow ? fs.statSync : fs.lstatSync)(target);
    if (stat.isDirectory()) return { kind: 'directory' };
    if (stat.isFile()) return { kind: 'file' };
    return { kind: 'other' };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'absent', error: error.code ?? error.message };
  }
}

/** The installed package root: `bin/` and `src/` and the skill sit side by side. */
function packageRoot() {
  return path.resolve(import.meta.dirname, '..', '..');
}

/** How to name, in a message, the thing standing at the target path. */
function describeTarget({ kind, error }) {
  if (error !== undefined) return `an entry that could not be read (${error})`;
  if (kind === 'directory') return 'a directory';
  if (kind === 'file') return 'a file';
  return 'a link or other entry';
}

export async function skillInstallCommand(values) {
  const root = packageRoot();

  // `--dir=` gives an empty string, which is not nullish, and path.resolve('')
  // is the current directory. Left alone that silently aims the install -- and,
  // under --force, the removal -- at ./reqable-cli. An empty value almost always
  // means the caller meant to omit the flag, so say that instead of guessing.
  if (values.dir !== undefined && String(values.dir).trim() === '') {
    throw usageError(
      '--dir was given an empty value. Pass a directory, or omit --dir to install into ' +
        `${defaultSkillsDir()}.`,
      { dir: values.dir },
    );
  }

  const skillsDir = path.resolve(values.dir ?? defaultSkillsDir());
  const targetDir = path.join(skillsDir, SKILL_NAME);

  // A --dir that names a file, cannot be inspected, or resolves to something that
  // is not a directory would otherwise fail deep inside mkdirSync as a raw
  // EEXIST/ENOTDIR/EACCES reported as INTERNAL_ERROR with exit 1. None of those is
  // an internal bug: they are the caller naming a path that cannot hold a skill,
  // so they get the exit code and the wording that says so. Symlinks resolve here
  // on purpose -- a skills directory kept in a dotfiles repository is a symlink.
  const dirInfo = inspectPath(skillsDir);
  const dirProblem =
    dirInfo.error !== undefined
      ? `cannot be used as a skills directory (${dirInfo.error})`
      : dirInfo.kind === 'file'
        ? 'is a file'
        : dirInfo.kind === 'other'
          ? 'is not a directory'
          : null;
  if (dirProblem !== null) {
    throw usageError(
      `--dir points at ${skillsDir}, which ${dirProblem}. ` +
        `Pass a directory that can hold a ${SKILL_NAME} subdirectory, or omit --dir to use ${defaultSkillsDir()}.`,
      { skillsDir },
    );
  }

  // Read every source file before touching the target, so a broken package
  // fails without leaving a half-written skill behind.
  const missing = [];
  const payload = [];
  for (const relative of SKILL_FILES) {
    const full = path.join(root, relative);
    try {
      payload.push({ relative, target: path.join(targetDir, relative), content: fs.readFileSync(full) });
    } catch {
      missing.push(relative);
    }
  }

  if (missing.length > 0) {
    throw new CliError(
      'SKILL_INCOMPLETE',
      `This installation of reqable-cli is missing part of the skill it ships with: ${missing.join(', ')}. ` +
        'That is a packaging defect, not something to work around; reinstall the package, and report it.',
      { exitCode: 1, details: { packageRoot: root, missing } },
    );
  }

  // lstat here, not stat: a target that is a link must be seen as itself, both
  // because the report should name what is actually in the way and because
  // removing a link is what makes --force safe (see the note at the removal).
  const targetInfo = inspectPath(targetDir, { follow: false });
  const targetKind = targetInfo.error !== undefined ? targetInfo.error : targetInfo.kind;
  const existing = targetInfo.kind !== 'absent' || targetInfo.error !== undefined;
  const bytes = payload.reduce((total, file) => total + file.content.length, 0);

  if (values['dry-run']) {
    return {
      data: {
        applied: false,
        skill: SKILL_NAME,
        skillsDir,
        targetDir,
        wouldOverwrite: existing,
        targetKind,
        files: SKILL_FILES,
        bytes,
      },
    };
  }

  // Overwriting an existing install replaces files the user may have edited, so
  // it takes the same explicit acknowledgement as any other destructive command.
  if (existing && !values.force) {
    throw confirmationError(
      `${targetDir} already exists as ${describeTarget(targetInfo)}. ` +
        'Re-run with --force to replace it, or pass --dir to install somewhere else.',
      { targetDir, skillsDir, targetKind },
    );
  }

  try {
    // Removed rather than overwritten in place, so a file left over from an older
    // version of the skill does not survive an install and keep being read. Only
    // ever the target subdirectory, and only under --force.
    //
    // Verified against a link: when the target is a symlink or a Windows
    // junction, rmSync removes the link and leaves its target untouched, so a
    // --force install can never reach outside <skillsDir>/reqable-cli. Do not
    // "fix" this into following the link.
    if (existing) fs.rmSync(targetDir, { recursive: true, force: true });

    for (const file of payload) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      fs.writeFileSync(file.target, file.content);
    }
  } catch (error) {
    // A path that cannot be written (ENOTDIR, EACCES, ENOSPC, EPERM) is the
    // caller's chosen location failing, not a bug in this command. Exit 1 is
    // reserved for "report this", so it is the wrong answer here.
    throw usageError(
      `Could not write the skill into ${targetDir} (${error.code ?? error.message}). ` +
        'Check the path and its permissions, or pass --dir to install somewhere else.',
      { targetDir, skillsDir, code: error.code },
    );
  }

  return {
    data: {
      applied: true,
      skill: SKILL_NAME,
      skillsDir,
      targetDir,
      overwrote: existing,
      targetKind,
      files: SKILL_FILES,
      bytes,
      hint: `An agent runtime that reads ${skillsDir} will pick up ${SKILL_NAME} from its next start.`,
    },
  };
}

export const skillSubcommands = {
  install: {
    run: (api, values) => skillInstallCommand(values),
    help: {
      command: 'skill install',
      noTransport: true,
      summary: 'write the agent-facing skill shipped with reqable-cli into a skills directory',
      options: [
        { name: '--dir <path>', description: 'Skills directory to install into. The skill goes in a reqable-cli subdirectory of it.' },
        {
          name: '--force',
          description:
            'Replace an existing install at the target path. The target is removed first, so files left over from an older install do not persist.',
        },
        { name: '--dry-run', description: 'Report where it would install and which files it would write, without writing them.' },
        { name: '--pretty', description: 'Indent the JSON output.' },
        { name: '--help', description: 'Show this help and exit 0.' },
      ],
      notes: `The default target is a reqable-cli directory under the user's ~/.agents/skills,
which is where agent runtimes look for skills.

This command never touches Reqable: it only writes files inside the chosen
directory. It refuses to overwrite an existing install without --force, and it
fails rather than installing a partial skill if the package is incomplete.

--force deletes and recreates <dir>/reqable-cli, so anything else stored there
goes with it. Nothing outside that one subdirectory is written or removed.`,
      examples: [
        'reqable-cli skill install --dry-run',
        'reqable-cli skill install',
        'reqable-cli skill install --dir /path/to/my/skills --force',
      ],
    },
    flags: {
      dir: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      pretty: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    maxPositionals: 0,
  },
};

export const skillHelp = {
  command: 'skill',
  noTransport: true,
  summary: 'install the agent-facing skill that ships with this package',
  options: [{ name: '<subcommand>', description: 'install', values: ['install'] }],
  notes: `Run "reqable-cli skill install --help" for the flags.

This is a setup command. It has nothing to do with Reqable's API, and an agent
never needs it mid-task: it writes the skill that tells an agent how to use the
rest of this CLI.`,
  examples: ['reqable-cli skill install', 'reqable-cli skill install --dir ./skills --force'],
};

export { SKILL_FILES, SKILL_NAME, defaultSkillsDir };
