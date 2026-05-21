import { existsSync, readdirSync, statSync, watch, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { SyncClient } from './sync-client.js';
import type { Identity, RepoConfig } from './config.js';

// Tails ~/.claude/projects/<slug>/sessions/*.jsonl for the linked repo and
// forwards every new line as a claudeEvent on the surd socket.
//
// Claude Code stores sessions under a directory derived from the working
// directory path (slashes → hyphens). We don't try to guess that mapping —
// instead we look in every project dir and forward sessions whose `cwd`
// matches the repo root.

interface SessionState {
  path: string;
  offset: number;
  seq: number;
  watcher: ReturnType<typeof watch> | null;
}

export class ClaudeBridge {
  private sessions = new Map<string, SessionState>();
  private dirWatchers: Array<ReturnType<typeof watch>> = [];
  private started = false;

  constructor(
    private readonly repoRoot: string,
    private readonly client: SyncClient,
    private readonly cfg: RepoConfig,
    private readonly identity: Identity,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const root = join(homedir(), '.claude', 'projects');
    if (!existsSync(root)) {
      console.log('[surd] no ~/.claude/projects — skipping Claude bridge');
      return;
    }
    this.scan(root);

    // Watch the projects root for newly created project dirs.
    try {
      const w = watch(root, { persistent: false }, () => this.scan(root));
      this.dirWatchers.push(w);
    } catch (err) {
      console.warn('[surd] could not watch claude projects root', err);
    }
  }

  stop(): void {
    for (const s of this.sessions.values()) s.watcher?.close();
    for (const w of this.dirWatchers) w.close();
  }

  private scan(root: string): void {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      return;
    }
    for (const name of dirs) {
      const projectDir = join(root, name);
      try {
        if (!statSync(projectDir).isDirectory()) continue;
      } catch { continue; }

      // Claude Code may write sessions either directly in the project dir
      // or under a `sessions/` subdir depending on version. Check both.
      const candidates = [projectDir, join(projectDir, 'sessions')];
      for (const dir of candidates) {
        if (!existsSync(dir)) continue;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith('.jsonl')) continue;
          const full = join(dir, f);
          this.trackSession(full);
        }

        // Watch this dir for new session files.
        if (!this.dirWatchers.some(_ => false)) {
          try {
            const w = watch(dir, { persistent: false }, (_evt, fname) => {
              if (fname && fname.endsWith('.jsonl')) this.trackSession(join(dir, fname));
            });
            this.dirWatchers.push(w);
          } catch { /* dir may have vanished */ }
        }
      }
    }
  }

  private trackSession(path: string): void {
    if (this.sessions.has(path)) return;
    let stats;
    try { stats = statSync(path); } catch { return; }
    // Decide if this session belongs to our repo. We do that by sniffing the
    // first record's `cwd` field. If it doesn't match, skip — saves us tailing
    // unrelated sessions on machines with many projects.
    this.sniffCwd(path).then(cwd => {
      if (cwd && cwd !== this.repoRoot) return;
      const state: SessionState = {
        path,
        // On startup we only forward new lines, not the entire history.
        // History is captured server-side via earlier sessions or via the
        // replay window.
        offset: stats.size,
        seq: 0,
        watcher: null,
      };
      try {
        state.watcher = watch(path, { persistent: false }, () => this.drain(state));
      } catch (err) {
        console.warn('[surd] watch failed', path, err);
        return;
      }
      this.sessions.set(path, state);
    }).catch(() => { /* ignore */ });
  }

  private async sniffCwd(path: string): Promise<string | null> {
    return new Promise(resolve => {
      const stream = createReadStream(path, { end: 65536 });
      const rl = createInterface({ input: stream });
      let done = false;
      rl.on('line', line => {
        if (done) return;
        try {
          const rec = JSON.parse(line) as { cwd?: string };
          if (rec.cwd) {
            done = true;
            rl.close();
            stream.destroy();
            resolve(rec.cwd);
          }
        } catch { /* skip bad lines */ }
      });
      rl.on('close', () => { if (!done) resolve(null); });
      rl.on('error', () => resolve(null));
    });
  }

  private drain(state: SessionState): void {
    let newSize: number;
    try { newSize = statSync(state.path).size; } catch { return; }
    if (newSize <= state.offset) {
      // File may have been truncated/rotated. Reset offset to current size.
      state.offset = newSize;
      return;
    }
    const stream = createReadStream(state.path, { start: state.offset, end: newSize - 1 });
    state.offset = newSize;
    let buffered = '';
    stream.on('data', chunk => {
      buffered += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (line.length === 0) continue;
        this.forward(state, line);
      }
    });
    stream.on('end', () => {
      const tail = buffered.trim();
      if (tail.length > 0) this.forward(state, tail);
    });
  }

  private forward(state: SessionState, line: string): void {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return; }
    const sessionId = sessionIdOf(state.path);
    state.seq += 1;
    this.client.sendControl({
      type: 'claudeEvent',
      event: {
        repoId: this.cfg.repoId,
        sessionId,
        user: this.identity.user,
        seq: state.seq,
        ts: Date.now(),
        record,
      },
    });
  }
}

function sessionIdOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.jsonl$/, '');
}
