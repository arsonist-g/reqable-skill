/**
 * Guard the branch <-> Reqable-version-line pairing.
 *
 * The policy this enforces (README.md, "Publishing and Reqable versions"):
 *
 *   main                tracks the newest Reqable line this project supports.
 *   reqable-<X.Y>       freezes the last build that worked against line X.Y.
 *
 * The hazard is a branch and the constants drifting apart, which does not fail
 * loudly: a `reqable-3.2` branch whose SUPPORTED_REQABLE says 3.3 would publish a
 * package that claims one line while carrying another's build, and the only
 * signal would be a user reporting that half the commands 404. This turns that
 * into a failure at the point of publishing.
 *
 * What it deliberately does NOT do:
 *
 * - It does not fail when there is no branch to check. A tarball checkout, a CI
 *   job on a detached HEAD, or a machine without git at all are all legitimate
 *   places to build from, and blocking a publish there would be a false alarm.
 *   Those cases say so loudly instead -- "NOT checked" is a different statement
 *   from "checked and fine", and conflating them is how a guard becomes
 *   decorative. An earlier version reported every git failure as "detached HEAD",
 *   which meant a broken git silently looked like a passed check.
 * - It does not try to be clever about branch names. Anything named `reqable-`
 *   followed by something that is not `X.Y` is a mistake worth naming, not a
 *   branch to wave through.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `major.minor` the code says it supports, read from the one place that owns it. */
function supportedLine() {
  const source = readFileSync(path.join(root, 'src', 'reqable.js'), 'utf8');
  const match = /export const SUPPORTED_REQABLE = '([^']+)'/.exec(source);
  if (!match) throw new Error('Could not find SUPPORTED_REQABLE in src/reqable.js');
  return match[1];
}

/** Run git, returning stdout, or throwing with git's own message attached. */
function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Why the branch cannot be checked, or null when it can. */
function branchUnavailableReason() {
  try {
    git(['rev-parse', '--git-dir']);
  } catch (error) {
    if (error.code === 'ENOENT') return 'git is not installed here';
    const detail = (error.stderr ?? '').trim().split('\n')[0];
    return `git could not read this directory${detail ? ` (${detail})` : ''}`;
  }
  return null;
}

/** Current branch, or null when HEAD is detached. Assumes git works. */
function currentBranch() {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

function fail(lines) {
  console.error(`git/version-line check: FAILED\n${lines.map((l) => `  ${l}`).join('\n')}`);
  process.exit(1);
}

const line = supportedLine();

const unavailable = branchUnavailableReason();
if (unavailable !== null) {
  console.log(
    `git/version-line check: NOT checked -- ${unavailable}. The branch <-> Reqable-line pairing was not verified; SUPPORTED_REQABLE is ${line}.`,
  );
  process.exit(0);
}

const branch = currentBranch();
if (branch === null) {
  console.log(
    `git/version-line check: NOT checked -- HEAD is detached, so there is no branch to compare. SUPPORTED_REQABLE is ${line}.`,
  );
  process.exit(0);
}

if (branch === 'main') {
  console.log(`git/version-line check: ok (main tracks the newest line, SUPPORTED_REQABLE=${line})`);
  process.exit(0);
}

const releaseLine = /^reqable-(.*)$/.exec(branch);
if (!releaseLine) {
  console.log(`git/version-line check: ok (branch "${branch}" is not a release-line branch)`);
  process.exit(0);
}

if (!/^\d+\.\d+$/.test(releaseLine[1])) {
  fail([
    `branch        ${branch}  (a release-line branch must be named reqable-<major.minor>)`,
    `SUPPORTED_REQABLE ${line}  (src/reqable.js)`,
    '',
    `"${releaseLine[1]}" is not a version line. Rename the branch to reqable-${line} if it`,
    'freezes the line this build supports, or to something outside the reqable- prefix if',
    'it is an ordinary working branch.',
  ]);
}

if (releaseLine[1] !== line) {
  fail([
    `branch        ${branch}  (freezes Reqable line ${releaseLine[1]})`,
    `SUPPORTED_REQABLE ${line}  (src/reqable.js)`,
    '',
    `A reqable-<X.Y> branch must build against line X.Y. Either this branch is`,
    `carrying a change that belongs on main, or SUPPORTED_REQABLE was updated in`,
    `the wrong place. Publishing here would ship a package whose declared line and`,
    `actual endpoints disagree.`,
  ]);
}

console.log(`git/version-line check: ok (${branch} freezes line ${line})`);
