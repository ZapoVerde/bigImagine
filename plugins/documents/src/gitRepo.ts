/**
 * @file plugins/documents/src/gitRepo.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — one local git repo per user, no remote
 * @description
 * Backs docs/spec.md §6.6's Document Repository: every user gets their own working repo under
 * BIGBRAIN_DOCUMENTS_DIR/<user_id>, so file-level access naturally matches the RLS isolation every
 * other table already gets — a single shared repo would let git access read straight through
 * Postgres row-level security, which per-user repos avoid by construction rather than by trusting
 * a credential's scope. No remote, no push, no auth: this is local version control only. Offsite
 * durability of this content is a real, currently-unaddressed gap — see §6.6's note on it; nothing
 * here should be read as solving that.
 *
 * Writes are `execFile`'d against a real `git` binary (argv arrays, never a shell string, since
 * commit messages/content can contain LLM-influenced text) and serialized per user (a promise
 * chain keyed by user_id, same shape as Notion sync's rate-limit throttle, §6.4) so two saves for
 * the same user never race on the same working tree; different users' repos are fully independent.
 *
 * @api-declaration
 * ensureUserRepo(userId) — creates/initializes the user's repo if it doesn't exist yet
 * writeDocumentFile(userId, filePath, content, commitMessage) — writes+commits, returns the
 *   resulting commit sha (the existing HEAD sha if the content was unchanged — not a new commit)
 * readDocumentFile(userId, filePath) — reads the file's current working-tree content
 * slugifyTitle(title) — pure helper, a title -> a safe `.md` filename
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem, child process)
 *     state_ownership: [the per-user write-serialization queue]
 *     external_io:     [filesystem, the local `git` binary]
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile as writeFileToDisk } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { log } from '@bigbrain/orchestrator/logger';

const execFileAsync = promisify(execFile);

const BASE_DIR = resolve(process.env.BIGBRAIN_DOCUMENTS_DIR ?? '/app/content');

const userQueues = new Map<string, Promise<unknown>>();

/** Runs fn after anything already queued for this user finishes, serializing same-user writes
 *  without blocking other users'. */
function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prior = userQueues.get(userId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  userQueues.set(userId, next.then(
    () => undefined,
    () => undefined,
  ));
  return next;
}

function userRepoDir(userId: string): string {
  return join(BASE_DIR, userId);
}

/** Confines a caller-supplied relative path to the user's own repo directory — a title-derived
 *  filename (slugifyTitle) is safe by construction, but a caller-supplied `path` argument is not,
 *  and a wrongly-resolved `../../elsewhere.md` must never escape one user's tree into another's or
 *  the host filesystem. */
function resolveSafePath(userId: string, filePath: string): string {
  const repoDir = userRepoDir(userId);
  const resolved = resolve(repoDir, filePath);
  if (resolved !== repoDir && !resolved.startsWith(repoDir + sep)) {
    throw new Error(`gitRepo: path "${filePath}" escapes user ${userId}'s repo`);
  }
  return resolved;
}

async function git(userId: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: userRepoDir(userId) });
  return stdout.trim();
}

export async function ensureUserRepo(userId: string): Promise<void> {
  const repoDir = userRepoDir(userId);
  await mkdir(repoDir, { recursive: true });
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: repoDir });
  } catch {
    log.info(`gitRepo: initializing new content repo for user ${userId}`);
    await execFileAsync('git', ['init'], { cwd: repoDir });
    // Local-only identity — this repo never pushes anywhere, so there's no real external author
    // to attribute commits to beyond "bigBrain, on this user's behalf."
    await execFileAsync('git', ['config', 'user.name', 'bigBrain'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'bigbrain@localhost'], { cwd: repoDir });
  }
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'untitled'}.md`;
}

export async function writeDocumentFile(
  userId: string,
  filePath: string,
  content: string,
  commitMessage: string,
): Promise<string> {
  return withUserLock(userId, async () => {
    await ensureUserRepo(userId);
    const absPath = resolveSafePath(userId, filePath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFileToDisk(absPath, content, 'utf8');
    await git(userId, ['add', '--', filePath]);
    try {
      await git(userId, ['commit', '-m', commitMessage, '--', filePath]);
    } catch (err) {
      // A re-save with byte-identical content leaves nothing staged — not a real failure, just
      // report the existing HEAD instead of throwing on a no-op save. git reports this on stdout,
      // not stderr (confirmed against this repo's actual node/git — promisify(execFile)'s rejection
      // carries both).
      const output = [(err as { stdout?: string })?.stdout, (err as { stderr?: string })?.stderr]
        .filter(Boolean)
        .join('\n');
      const message = err instanceof Error ? err.message : String(err);
      if (!output.includes('nothing to commit') && !message.includes('nothing to commit')) throw err;
      log.info(`gitRepo: ${filePath} for user ${userId} unchanged, no new commit`);
    }
    const sha = await git(userId, ['rev-parse', 'HEAD']);
    log.info(`gitRepo: ${filePath} for user ${userId} at commit ${sha.slice(0, 12)}`);
    return sha;
  });
}

export async function readDocumentFile(userId: string, filePath: string): Promise<string> {
  const absPath = resolveSafePath(userId, filePath);
  return readFile(absPath, 'utf8');
}
