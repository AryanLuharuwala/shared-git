import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

// Per-repo surd config lives at .git/surd/config.json so it travels with the
// working tree but doesn't pollute it (git ignores everything under .git).
//
// Global identity (user id, default server) lives at ~/.config/surd/identity.json
// so multiple repos can share it.

export interface RepoConfig {
  repoId: string;          // the id registered with the server
  server: string;          // wss://... URL with /sync omitted
  branch: string;          // tracked branch (today: must equal current git branch)
  token: string | null;    // optional bearer token
  // Tracked-file globs. Default excludes binary blobs and node_modules. Live
  // CRDT sync is wasteful for huge generated trees; users opt files in/out.
  include: string[];
  exclude: string[];
}

export interface Identity {
  user: string;            // stable user id, used as the author label
  clientId: string;        // per-install id (rotates if user runs `surd reset`)
}

export function repoRoot(cwd: string = process.cwd()): string {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    throw new Error('not inside a git repository — run `git init` or clone first');
  }
}

export function repoConfigPath(root: string): string {
  return join(root, '.git', 'surd', 'config.json');
}

export function loadRepoConfig(root: string): RepoConfig | null {
  const p = repoConfigPath(root);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as RepoConfig;
}

export function saveRepoConfig(root: string, cfg: RepoConfig): void {
  const p = repoConfigPath(root);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}

function identityPath(): string {
  return join(homedir(), '.config', 'surd', 'identity.json');
}

export function loadIdentity(): Identity {
  const p = identityPath();
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, 'utf8')) as Identity;
  }
  const id: Identity = {
    user: process.env.USER ?? 'anonymous',
    clientId: crypto.randomUUID(),
  };
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(id, null, 2));
  return id;
}

// Git helpers — we shell out rather than embedding a git library since we only
// need three things and `git` is always available wherever surd is.
export function gitRemoteUrl(root: string): string {
  try {
    return execSync('git remote get-url origin', {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return '';
  }
}

export function gitCurrentBranch(root: string): string {
  // `git rev-parse --abbrev-ref HEAD` fails on an unborn branch (no commits
  // yet). `git symbolic-ref --short HEAD` works in that case — it returns
  // the branch name HEAD points at even when nothing is committed.
  try {
    return execSync('git symbolic-ref --short HEAD', {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'main';
  }
}

export function gitHeadCommit(root: string): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return ''; // unborn branch
  }
}
