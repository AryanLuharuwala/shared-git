import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BinaryFrame, encodeBinary } from '@surd/shared';
import type { Storage } from './storage.js';
import type { ServerConfig } from './config.js';
import type { WebSocket } from 'ws';

// One LiveDoc per (repoId, branch). Holds the in-memory Yjs document, awareness
// state, and the set of connected sockets subscribed to it. The hub is the
// only thing that talks to Yjs directly — connections just hand bytes off.

interface LiveDoc {
  key: string;
  repoId: string;
  branch: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
  lastTouchedAt: number;
  pendingFlush: NodeJS.Timeout | null;
}

export class Hub {
  private docs = new Map<string, LiveDoc>();
  private idleSweep: NodeJS.Timeout;

  constructor(private storage: Storage, private config: ServerConfig) {
    // Periodically flush + evict docs with no subscribers. We don't evict
    // aggressively — keeping a doc warm lets new connections jump straight to
    // current state without paying disk I/O.
    this.idleSweep = setInterval(() => this.sweepIdle(), 30_000);
    this.idleSweep.unref();
  }

  shutdown(): void {
    clearInterval(this.idleSweep);
    for (const live of this.docs.values()) {
      this.flush(live);
    }
  }

  private docKey(repoId: string, branch: string): string {
    return `${repoId}::${branch}`;
  }

  // Get-or-create. Loads persisted state on first access so the in-memory doc
  // is always up-to-date with what was last flushed.
  acquire(repoId: string, branch: string, conn: WebSocket): LiveDoc {
    const key = this.docKey(repoId, branch);
    let live = this.docs.get(key);
    if (!live) {
      const doc = new Y.Doc({ gc: true });
      const persisted = this.storage.loadDocState(repoId, branch);
      if (persisted && persisted.length > 0) {
        Y.applyUpdate(doc, persisted);
      }
      live = {
        key,
        repoId,
        branch,
        doc,
        awareness: new awarenessProtocol.Awareness(doc),
        conns: new Set(),
        lastTouchedAt: Date.now(),
        pendingFlush: null,
      };
      // Whenever the doc changes, schedule a debounced flush and fan the
      // update out to every other subscriber. We never echo to the origin —
      // Yjs already incorporated the local update.
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        live!.lastTouchedAt = Date.now();
        this.scheduleFlush(live!);
        const frame = encodeSyncUpdate(update);
        for (const ws of live!.conns) {
          if (ws !== origin && ws.readyState === ws.OPEN) {
            ws.send(frame);
          }
        }
      });
      live.awareness.on('update', (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = added.concat(updated, removed);
        const payload = awarenessProtocol.encodeAwarenessUpdate(live!.awareness, changed);
        const frame = encodeBinary(BinaryFrame.YjsAwareness, payload);
        for (const ws of live!.conns) {
          if (ws !== origin && ws.readyState === ws.OPEN) {
            ws.send(frame);
          }
        }
      });
      this.docs.set(key, live);
    }
    live.conns.add(conn);
    live.lastTouchedAt = Date.now();
    return live;
  }

  release(live: LiveDoc, conn: WebSocket): void {
    live.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(
      live.awareness,
      [conn as unknown as number], // we keyed awareness by connection identity below
      conn,
    );
    if (live.conns.size === 0) {
      this.flush(live);
    }
  }

  // Send the initial sync handshake (sync step 1) plus our current awareness
  // snapshot to a freshly subscribed connection.
  sendInitialSync(live: LiveDoc, conn: WebSocket): void {
    const enc = encoding.createEncoder();
    syncProtocol.writeSyncStep1(enc, live.doc);
    conn.send(encodeBinary(BinaryFrame.YjsSync, encoding.toUint8Array(enc)));

    const states = live.awareness.getStates();
    if (states.size > 0) {
      const payload = awarenessProtocol.encodeAwarenessUpdate(
        live.awareness,
        Array.from(states.keys()),
      );
      conn.send(encodeBinary(BinaryFrame.YjsAwareness, payload));
    }
  }

  // Process an incoming Yjs binary frame from a client. Handles all three
  // sync sub-message types and emits the reply (if any) back on `conn`.
  handleSync(live: LiveDoc, payload: Uint8Array, conn: WebSocket): void {
    const dec = decoding.createDecoder(payload);
    const enc = encoding.createEncoder();
    const messageType = syncProtocol.readSyncMessage(dec, enc, live.doc, conn);
    // readSyncMessage writes the reply (sync step 2 or update) into `enc` when
    // appropriate. Only flush if there's actually a reply to send.
    if (encoding.length(enc) > 1) {
      conn.send(encodeBinary(BinaryFrame.YjsSync, encoding.toUint8Array(enc)));
    }
    void messageType;
  }

  handleAwareness(live: LiveDoc, payload: Uint8Array, conn: WebSocket): void {
    awarenessProtocol.applyAwarenessUpdate(live.awareness, payload, conn);
  }

  private scheduleFlush(live: LiveDoc): void {
    if (live.pendingFlush) return;
    // Debounce: batch rapid updates into a single snapshot write.
    live.pendingFlush = setTimeout(() => {
      live.pendingFlush = null;
      this.flush(live);
    }, 1_000);
  }

  private flush(live: LiveDoc): void {
    if (live.pendingFlush) {
      clearTimeout(live.pendingFlush);
      live.pendingFlush = null;
    }
    const state = Y.encodeStateAsUpdate(live.doc);
    this.storage.saveDocState(live.repoId, live.branch, state);
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.config.docIdleMs;
    for (const [key, live] of this.docs) {
      if (live.conns.size === 0 && live.lastTouchedAt < cutoff) {
        this.flush(live);
        live.doc.destroy();
        this.docs.delete(key);
      }
    }
  }
}

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  syncProtocol.writeUpdate(enc, update);
  return encodeBinary(BinaryFrame.YjsSync, encoding.toUint8Array(enc));
}
