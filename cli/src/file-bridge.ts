import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import * as Y from 'yjs';
import type { SyncClient } from './sync-client.js';
import type { RepoConfig } from './config.js';

// Maps git working tree files <-> a Y.Map<Y.Text> shared doc.
//
// Design:
//   - One Y.Text per tracked file path, stored in `files: Y.Map<Y.Text>`.
//   - On startup, every tracked file is seeded into the doc only if no Yjs
//     state for that path exists yet. This makes the latecomer case work: the
//     existing CRDT state wins.
//   - Local writes (editor saves) → diff against current Y.Text and apply the
//     minimum edit to keep history compact. Done as a Y.Doc transaction tagged
//     'fs' so we don't echo back to disk.
//   - Remote updates (Y.Text observed) → write to disk, tagged so the chokidar
//     event we trigger doesn't bounce back as a "local" change.
//
// We deliberately do not try to handle large binary files. Anything outside
// the include/exclude rules stays git-only.

const FS_ORIGIN = 'fs';
const REMOTE_ORIGIN = 'remote';

export class FileBridge {
  private files: Y.Map<Y.Text>;
  private watcher: FSWatcher | null = null;
  // Paths we're about to write from a remote update. The chokidar event for
  // that write is suppressed so we don't loop.
  private suppress = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly client: SyncClient,
    private readonly cfg: RepoConfig,
  ) {
    this.files = this.client.doc.getMap<Y.Text>('files');
  }

  start(): void {
    this.seedFromDisk();
    this.observeRemote();
    this.watchLocal();
  }

  stop(): void {
    void this.watcher?.close();
  }

  // Walk the working tree and ensure every tracked file is represented in the
  // CRDT. If a file is already present (from a prior session), we trust the
  // CRDT and overwrite disk to converge — except on the very first run, where
  // the CRDT is empty and disk seeds it.
  private seedFromDisk(): void {
    const tracked = this.listTracked();
    this.client.doc.transact(() => {
      for (const rel of tracked) {
        const abs = resolve(this.root, rel);
        if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
        const content = safeReadText(abs);
        if (content === null) continue;
        const existing = this.files.get(rel);
        if (!existing) {
          const ytext = new Y.Text();
          ytext.insert(0, content);
          this.files.set(rel, ytext);
        }
      }
    }, FS_ORIGIN);

    // After seeding, for any file the CRDT already had, overwrite disk to
    // match the (authoritative) shared state.
    this.files.forEach((ytext, rel) => {
      this.writeFromRemote(rel, ytext.toString());
    });
  }

  private observeRemote(): void {
    // New files added to the shared doc → create on disk and start observing.
    this.files.observe(event => {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'add' || change.action === 'update') {
          const ytext = this.files.get(key);
          if (ytext) {
            this.attachTextObserver(key, ytext);
            this.writeFromRemote(key, ytext.toString());
          }
        } else if (change.action === 'delete') {
          // We don't delete files from disk automatically — collaborators
          // removing tracked content from the doc is a destructive op that
          // should go through `git rm`. Keep the file but it stops syncing.
        }
      });
    });

    // Attach observers to anything already present from initial state.
    this.files.forEach((ytext, key) => this.attachTextObserver(key, ytext));
  }

  private attachTextObserver(rel: string, ytext: Y.Text): void {
    // Avoid double-attaching by stamping the ytext.
    const stamped = ytext as Y.Text & { _surdObserved?: boolean };
    if (stamped._surdObserved) return;
    stamped._surdObserved = true;
    ytext.observe(event => {
      if (event.transaction.origin === FS_ORIGIN) return;
      this.writeFromRemote(rel, ytext.toString());
    });
  }

  private writeFromRemote(rel: string, content: string): void {
    const abs = resolve(this.root, rel);
    if (existsSync(abs)) {
      const onDisk = safeReadText(abs);
      if (onDisk === content) return; // already in sync
    }
    mkdirSync(dirname(abs), { recursive: true });
    this.suppress.add(abs);
    writeFileSync(abs, content);
    // Suppress just one event — chokidar fires once per write.
    setTimeout(() => this.suppress.delete(abs), 500);
  }

  private watchLocal(): void {
    // Chokidar v4 reduced its glob support — we use a function matcher and
    // apply our own include/exclude rules. The matcher must return true to
    // SKIP. We deliberately return false for the root itself so the tree is
    // traversed, and false for files matching our rules.
    this.watcher = chokidar.watch(this.root, {
      ignored: (p: string, stats?: { isFile(): boolean }) => {
        const rel = relative(this.root, p);
        if (rel === '') return false; // never ignore the root
        if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) return true;
        // Match excludes against any path segment.
        const segs = rel.split(/[\\/]/);
        for (const pat of this.cfg.exclude) {
          const bare = pat.replace(/\/$/, '');
          if (segs.includes(bare)) return true;
        }
        // For files, also enforce isTracked (include list).
        if (stats?.isFile()) return !this.isTracked(rel);
        return false;
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
    });

    const handle = (abs: string) => {
      if (this.suppress.has(abs)) return;
      const rel = relative(this.root, abs);
      if (!this.isTracked(rel)) return;
      if (!existsSync(abs)) return;
      const content = safeReadText(abs);
      if (content === null) return;
      this.client.doc.transact(() => {
        let ytext = this.files.get(rel);
        if (!ytext) {
          ytext = new Y.Text();
          this.files.set(rel, ytext);
        }
        applyTextDiff(ytext, content);
      }, FS_ORIGIN);
    };

    this.watcher.on('add', handle);
    this.watcher.on('change', handle);
    this.watcher.on('error', err => console.error('[surd] watcher error', err));
  }

  private listTracked(): string[] {
    try {
      const out = execSync('git ls-files', { cwd: this.root, maxBuffer: 32 * 1024 * 1024 })
        .toString();
      return out.split('\n').filter(l => l.length > 0 && this.isTracked(l));
    } catch {
      return [];
    }
  }

  private isTracked(rel: string): boolean {
    if (this.cfg.exclude.some(pat => rel.includes(pat))) return false;
    if (this.cfg.include.length === 0) return true;
    return this.cfg.include.some(pat => rel.includes(pat));
  }
}

function safeReadText(path: string): string | null {
  try {
    const buf = readFileSync(path);
    // Skip files that look binary (NUL byte in the first 8KB).
    const sniff = buf.subarray(0, Math.min(8192, buf.length));
    if (sniff.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// Minimal diff: find the common prefix and suffix between current and target,
// then replace the middle in a single Yjs op. Yjs deduplicates internally so
// this keeps history small for tiny edits and stays correct for big rewrites.
function applyTextDiff(ytext: Y.Text, target: string): void {
  const current = ytext.toString();
  if (current === target) return;

  let prefix = 0;
  const minLen = Math.min(current.length, target.length);
  while (prefix < minLen && current[prefix] === target[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) suffix++;

  const removeLen = current.length - prefix - suffix;
  const insertStr = target.slice(prefix, target.length - suffix);

  if (removeLen > 0) ytext.delete(prefix, removeLen);
  if (insertStr.length > 0) ytext.insert(prefix, insertStr);
}
