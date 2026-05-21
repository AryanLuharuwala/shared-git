import type { WebSocket } from 'ws';
import type { ClaudeEvent } from '@surd/shared';
import type { Storage } from './storage.js';

// Claude session relay. Per repo, every connection that opted-in gets a copy
// of every claude event we observe. We also persist events to SQLite so
// latecomers can pull the recent tail.

interface Subscriber {
  ws: WebSocket;
  user: string;
}

export class ClaudeRelay {
  private subs = new Map<string, Set<Subscriber>>();

  constructor(private storage: Storage) {}

  subscribe(repoId: string, sub: Subscriber): void {
    let set = this.subs.get(repoId);
    if (!set) {
      set = new Set();
      this.subs.set(repoId, set);
    }
    set.add(sub);
  }

  unsubscribe(repoId: string, sub: Subscriber): void {
    this.subs.get(repoId)?.delete(sub);
  }

  // Returns true if the event was newly recorded, false if it was a dup.
  ingest(event: ClaudeEvent): boolean {
    const inserted = this.storage.appendClaudeEvent({
      repo_id: event.repoId,
      session_id: event.sessionId,
      seq: event.seq,
      user: event.user,
      ts: event.ts,
      record: event.record,
    });
    if (!inserted) return false;

    // Fanout. We never send back to the originating user — they already have
    // this line in their local JSONL.
    const set = this.subs.get(event.repoId);
    if (!set) return true;
    const frame = JSON.stringify({ type: 'claudeEvent', event });
    for (const sub of set) {
      if (sub.user !== event.user && sub.ws.readyState === sub.ws.OPEN) {
        sub.ws.send(frame);
      }
    }
    return true;
  }

  // For a freshly-subscribed client, replay the tail of recent activity so
  // they don't see a cold panel.
  replayRecent(repoId: string, sinceMs: number, ws: WebSocket): void {
    const rows = this.storage.recentClaudeEvents(repoId, Date.now() - sinceMs);
    for (const r of rows) {
      const event: ClaudeEvent = {
        repoId,
        sessionId: r.session_id,
        user: r.user,
        seq: r.seq,
        ts: r.ts,
        record: JSON.parse(r.record),
      };
      ws.send(JSON.stringify({ type: 'claudeEvent', event }));
    }
  }
}
