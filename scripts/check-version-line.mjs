/**
 * Guard the branch ↔ Reqable-version-line pairing.
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
 * A detached HEAD (CI, a tarball checkout) has no branch to compare, so the check
 * reports that it was skipped rather than failing: the guard exists to catch a
 * mistake a human made on a branch, not to block a build that has no branch.
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

/** Current branch, or null when HEAD is detached. */
function currentBranch() {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const line = supportedLine();
const branch = currentBranch();

if (branch === null) {
  console.log(`git/version-line check: skipped (detached HEAD; SUPPORTED_REQABLE=${line})`);
  process.exit(0);
}

if (branch === 'main') {
  console.log(`git/version-line check: ok (main tracks the newest line, SUPPORTED_REQABLE=${line})`);
  process.exit(0);
}

const frozen = /^reqable-(\d+\.\d+)$/.exec(branch);
if (!frozen) {
  console.log(`git/version-line check: ok (branch "${branch}" is not a release-line branch)`);
  process.exit(0);
}

if (frozen[1] !== line) {
  console.error(
    `git/version-line check: FAILED\n` +
      `  branch         ${branch}  (freezes Reqable line ${frozen[1]})\n` +
      `  SUPPORTED_REQABLE ${line}  (src/reqable.js)\n\n` +
      `A reqable-<X.Y> branch must build against line X.Y. Either this branch is\n` +
      `carrying a change that belongs on main, or SUPPORTED_REQABLE was updated in\n` +
      `the wrong place. Publishing here would ship a package whose declared line and\n` +
      `actual endpoints disagree.`,
  );
  process.exit(1);
}

console.log(`git/version-line check: ok (${branch} freezes line ${line})`);
