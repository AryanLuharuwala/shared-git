#!/usr/bin/env node
import {
  gitCurrentBranch,
  gitHeadCommit,
  gitRemoteUrl,
  loadIdentity,
  loadRepoConfig,
  repoRoot,
  saveRepoConfig,
  type RepoConfig,
} from './config.js';
import { SyncClient } from './sync-client.js';
import { FileBridge } from './file-bridge.js';
import { ClaudeBridge } from './claude-bridge.js';
import type { ControlMessage } from '@surd/shared';

const USAGE = `
surd — git-aware live collaboration

  surd link <server> [--token TOKEN] [--repo-id ID]
      Register the current repo with a surd server and persist config under
      .git/surd/config.json. Default repo id is "<gitRemote>#<branch>".

  surd watch
      Start the sync daemon: file watcher → CRDT → server, plus Claude
      session relay. Runs in the foreground.

  surd status
      Show link status and recent commits known to the server.

  surd commit -m "..."
      Convenience: git add -A, git commit, then notify the server.

  surd unlink
      Remove local surd config (does not touch the server).
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'link':      return await cmdLink(rest);
    case 'watch':     return await cmdWatch();
    case 'status':    return await cmdStatus();
    case 'commit':    return await cmdCommit(rest);
    case 'unlink':    return await cmdUnlink();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(USAGE);
      process.exitCode = 2;
  }
}

async function cmdLink(args: string[]): Promise<void> {
  const server = args[0];
  if (!server) throw new Error('usage: surd link <server>');
  const root = repoRoot();
  const remote = gitRemoteUrl(root);
  const branch = gitCurrentBranch(root);
  const tokenFlag = flag(args, '--token');
  const repoId = flag(args, '--repo-id') ?? `${remote || `local:${root}`}#${branch}`;

  // Register the repo with the server first — if that fails we don't write
  // local config (avoids stale state).
  const httpBase = wsToHttp(server);
  const res = await fetch(`${httpBase}/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: repoId, gitRemote: remote, defaultBranch: branch }),
  });
  if (!res.ok) throw new Error(`server rejected repo registration: ${res.status} ${await res.text()}`);

  const cfg: RepoConfig = {
    repoId,
    server,
    branch,
    token: tokenFlag ?? null,
    include: [],
    exclude: ['node_modules/', 'dist/', 'build/', '.next/', '.git/'],
  };
  saveRepoConfig(root, cfg);
  console.log(`linked ${repoId} → ${server}`);
}

async function cmdWatch(): Promise<void> {
  const root = repoRoot();
  const cfg = loadRepoConfig(root);
  if (!cfg) throw new Error('repo not linked — run `surd link <server>` first');
  const identity = loadIdentity();

  const client = new SyncClient(cfg, identity);
  const fileBridge = new FileBridge(root, client, cfg);
  const claudeBridge = new ClaudeBridge(root, client, cfg, identity);

  client.on('connect', () => console.log(`[surd] connected to ${cfg.server}`));
  client.on('disconnect', () => console.log('[surd] disconnected, will retry'));
  client.on('control', (msg: ControlMessage) => {
    if (msg.type === 'welcome') {
      console.log(`[surd] welcome — branch=${msg.branch} head=${msg.commit ?? '(none)'}`);
      // File bridge needs to wait for the initial sync to complete so we don't
      // overwrite remote state with stale local state. We give Yjs a beat to
      // apply sync-step-2 before seeding from disk. Trade-off: very small race
      // window where local edits during this beat could be missed.
      setTimeout(() => fileBridge.start(), 250);
      claudeBridge.start();
    } else if (msg.type === 'error') {
      console.error(`[surd] server error: ${msg.code} ${msg.message}`);
    } else if (msg.type === 'claudeEvent') {
      // For the CLI we just print a one-liner; the VS Code extension renders
      // these properly.
      const rec = msg.event.record as { type?: string; message?: { content?: unknown } };
      const kind = rec?.type ?? 'event';
      console.log(`[claude:${msg.event.user}] ${kind}`);
    }
  });

  client.connect();

  const shutdown = () => {
    console.log('\n[surd] shutting down');
    fileBridge.stop();
    claudeBridge.stop();
    client.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus(): Promise<void> {
  const root = repoRoot();
  const cfg = loadRepoConfig(root);
  if (!cfg) { console.log('not linked'); return; }
  console.log(`repo:   ${cfg.repoId}`);
  console.log(`server: ${cfg.server}`);
  console.log(`branch: ${cfg.branch}`);
  console.log(`git head: ${gitHeadCommit(root)}`);
  try {
    const res = await fetch(`${wsToHttp(cfg.server)}/health`);
    console.log(`server health: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.log(`server health: unreachable (${(err as Error).message})`);
  }
}

async function cmdCommit(args: string[]): Promise<void> {
  const root = repoRoot();
  const cfg = loadRepoConfig(root);
  if (!cfg) throw new Error('repo not linked');
  const msg = flag(args, '-m') ?? flag(args, '--message');
  if (!msg) throw new Error('usage: surd commit -m "message"');

  const { execSync } = await import('node:child_process');
  execSync('git add -A', { cwd: root, stdio: 'inherit' });
  execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: root, stdio: 'inherit' });
  const commit = gitHeadCommit(root);
  const branch = gitCurrentBranch(root);
  const author = execSync('git log -1 --format=%an', { cwd: root }).toString().trim();

  const res = await fetch(`${wsToHttp(cfg.server)}/commits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoId: cfg.repoId, branch, commit, author, message: msg }),
  });
  if (!res.ok) {
    console.warn(`[surd] could not notify server: ${res.status}`);
  } else {
    console.log(`[surd] notified server: ${commit.slice(0, 8)} on ${branch}`);
  }
}

async function cmdUnlink(): Promise<void> {
  const root = repoRoot();
  const { unlinkSync, existsSync } = await import('node:fs');
  const { repoConfigPath } = await import('./config.js');
  const p = repoConfigPath(root);
  if (existsSync(p)) {
    unlinkSync(p);
    console.log('unlinked');
  } else {
    console.log('was not linked');
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function wsToHttp(server: string): string {
  return server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
