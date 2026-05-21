import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { ServerConfig } from './config.js';

// Storage layer. Two halves:
//   1. SQLite for repo registry, branches, commits, Claude event log
//   2. Filesystem blobs for serialized Yjs doc state (one file per repo+branch)
//
// We don't try to keep Yjs updates in SQLite — Yjs already has its own efficient
// binary update format and frequent small writes are better served by appending
// to a per-doc file. On flush we collapse updates into a single snapshot.

export interface RepoRow {
  id: string;
  git_remote: string;
  default_branch: string;
  created_at: number;
}

export interface CommitRow {
  repo_id: string;
  branch: string;
  commit_sha: string;
  author: string;
  message: string;
  ts: number;
}

export class Storage {
  readonly db: Database.Database;
  readonly dataDir: string;

  constructor(config: ServerConfig) {
    this.dataDir = config.dataDir;
    this.db = new Database(resolve(config.dataDir, 'surd.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        git_remote TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commits (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        branch TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        author TEXT NOT NULL,
        message TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (repo_id, branch, commit_sha)
      );

      CREATE INDEX IF NOT EXISTS commits_by_ts ON commits(repo_id, ts DESC);

      CREATE TABLE IF NOT EXISTS branches (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        head_commit TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, name)
      );

      -- Claude event log. Capped at the most recent 10k entries per repo via a
      -- background trim — we never query historical sessions in detail, only
      -- recent ones so latecomers can catch up the tail of a conversation.
      CREATE TABLE IF NOT EXISTS claude_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        user TEXT NOT NULL,
        ts INTEGER NOT NULL,
        record TEXT NOT NULL,
        UNIQUE (repo_id, session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS claude_by_repo_ts
        ON claude_events(repo_id, ts DESC);
    `);
  }

  upsertRepo(repo: RepoRow): void {
    this.db.prepare(`
      INSERT INTO repos (id, git_remote, default_branch, created_at)
      VALUES (@id, @git_remote, @default_branch, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        git_remote = excluded.git_remote,
        default_branch = excluded.default_branch
    `).run(repo);
  }

  getRepo(id: string): RepoRow | undefined {
    return this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow | undefined;
  }

  listRepos(): RepoRow[] {
    return this.db.prepare(`SELECT * FROM repos ORDER BY created_at DESC`).all() as RepoRow[];
  }

  recordCommit(row: CommitRow): void {
    const tx = this.db.transaction((r: CommitRow) => {
      this.db.prepare(`
        INSERT OR REPLACE INTO commits (repo_id, branch, commit_sha, author, message, ts)
        VALUES (@repo_id, @branch, @commit_sha, @author, @message, @ts)
      `).run(r);
      this.db.prepare(`
        INSERT INTO branches (repo_id, name, head_commit, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(repo_id, name) DO UPDATE SET
          head_commit = excluded.head_commit,
          updated_at = excluded.updated_at
      `).run(r.repo_id, r.branch, r.commit_sha, r.ts);
    });
    tx(row);
  }

  branchHead(repoId: string, branch: string): { commit: string | null; branch: string } {
    // Note: SQLite reserves `commit`, so the column stays `head_commit` and
    // we re-map in JS rather than aliasing in SQL.
    const row = this.db.prepare(`
      SELECT head_commit FROM branches WHERE repo_id = ? AND name = ?
    `).get(repoId, branch) as { head_commit: string | null } | undefined;
    return { commit: row?.head_commit ?? null, branch };
  }

  appendClaudeEvent(row: {
    repo_id: string; session_id: string; seq: number; user: string; ts: number; record: unknown;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO claude_events (repo_id, session_id, seq, user, ts, record)
        VALUES (@repo_id, @session_id, @seq, @user, @ts, @record)
      `).run({ ...row, record: JSON.stringify(row.record) });
      return true;
    } catch (err: unknown) {
      // UNIQUE violation → already saw this seq, harmless replay.
      if (err && typeof err === 'object' && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return false;
      }
      throw err;
    }
  }

  recentClaudeEvents(repoId: string, since: number): Array<{
    session_id: string; seq: number; user: string; ts: number; record: string;
  }> {
    return this.db.prepare(`
      SELECT session_id, seq, user, ts, record FROM claude_events
      WHERE repo_id = ? AND ts > ?
      ORDER BY ts ASC
      LIMIT 1000
    `).all(repoId, since) as Array<{
      session_id: string; seq: number; user: string; ts: number; record: string;
    }>;
  }

  // Yjs doc snapshot path: one file per (repo, branch). We deliberately do not
  // store deltas separately — Yjs merges efficiently on load, and a single
  // snapshot file is the simplest crash-safe representation.
  docPath(repoId: string, branch: string): string {
    const safe = branch.replace(/[^a-zA-Z0-9._-]/g, '_');
    return resolve(this.dataDir, 'docs', `${encodeURIComponent(repoId)}__${safe}.ybin`);
  }

  loadDocState(repoId: string, branch: string): Uint8Array | null {
    const p = this.docPath(repoId, branch);
    if (!existsSync(p)) return null;
    return new Uint8Array(readFileSync(p));
  }

  saveDocState(repoId: string, branch: string, state: Uint8Array): void {
    // Write to temp then rename for atomicity.
    const p = this.docPath(repoId, branch);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, state);
    // Atomic on the same filesystem — safe against crashes mid-write.
    renameSync(tmp, p);
  }
}
