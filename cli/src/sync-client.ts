import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BinaryFrame, decodeBinary, encodeBinary, type ControlMessage } from '@surd/shared';
import { EventEmitter } from 'node:events';
import type { Identity, RepoConfig } from './config.js';

// Client side of the WebSocket sync protocol. Wraps the connection lifecycle,
// reconnection, and the Yjs handshake. Consumers interact with `doc` directly
// — every local mutation is automatically pushed to the server, and remote
// updates are merged in.

export interface SyncClientEvents {
  connect: () => void;
  disconnect: () => void;
  control: (msg: ControlMessage) => void;
}

export class SyncClient extends EventEmitter {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private outboundQueue: Uint8Array[] = [];

  constructor(private cfg: RepoConfig, private identity: Identity) {
    super();

    // Every local doc update gets shipped to the server. The server echoes to
    // other clients but never back to us, so we don't risk loops.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.sendBinary(encodeBinary(BinaryFrame.YjsSync, encoding.toUint8Array(enc)));
    });

    this.awareness.on('update', (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === 'remote') return;
      const changed = added.concat(updated, removed);
      const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      this.sendBinary(encodeBinary(BinaryFrame.YjsAwareness, payload));
    });
  }

  connect(): void {
    if (this.ws || this.closed) return;
    const url = `${this.cfg.server.replace(/\/+$/, '')}/sync`;
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.send({
        type: 'hello',
        protocol: 1,
        repoId: this.cfg.repoId,
        clientId: this.identity.clientId,
        user: this.identity.user,
        token: this.cfg.token ?? undefined,
      });
      this.send({ type: 'subscribeClaude' });
      // Y.js sync requires BOTH peers to send step 1 so each side learns what
      // the other is missing. The server sends its own step 1 on welcome; we
      // send ours here so the server replies with step 2 (giving us any state
      // we don't have yet — e.g. other collaborators' edits).
      const enc = encoding.createEncoder();
      syncProtocol.writeSyncStep1(enc, this.doc);
      ws.send(encodeBinary(BinaryFrame.YjsSync, encoding.toUint8Array(enc)));
      // Drain queued updates that accumulated while offline.
      for (const frame of this.outboundQueue) ws.send(frame);
      this.outboundQueue.length = 0;
      this.emit('connect');
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.onBinary(data as Buffer);
      try {
        const msg = JSON.parse(data.toString('utf8')) as ControlMessage;
        this.emit('control', msg);
      } catch (err) {
        console.error('[surd] bad control message', err);
      }
    });

    ws.on('close', () => {
      this.ws = null;
      this.emit('disconnect');
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on('error', err => {
      console.error('[surd] socket error', err.message);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  sendControl(msg: ControlMessage): void {
    this.send(msg);
  }

  private send(msg: ControlMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Control messages aren't queued — they're either liveness/handshake (no
    // point sending stale ones) or recorded server-side via REST already.
  }

  private sendBinary(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      // Queue while offline. Yjs updates are commutative and idempotent, so
      // dumping a backlog on reconnect produces the same merged state.
      this.outboundQueue.push(frame);
      // Hard cap so a long outage doesn't OOM us.
      if (this.outboundQueue.length > 10_000) this.outboundQueue.shift();
    }
  }

  private onBinary(buf: Buffer): void {
    const { type, payload } = decodeBinary(new Uint8Array(buf));
    if (type === BinaryFrame.YjsSync) {
      const dec = decoding.createDecoder(payload);
      const enc = encoding.createEncoder();
      syncProtocol.readSyncMessage(dec, enc, this.doc, 'remote');
      if (encoding.length(enc) > 1) {
        this.sendBinary(encodeBinary(BinaryFrame.YjsSync, encoding.toUint8Array(enc)));
      }
    } else if (type === BinaryFrame.YjsAwareness) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, 'remote');
    }
  }

  private scheduleReconnect(): void {
    // Simple linear backoff capped at 30s. Could go exponential later.
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2_000);
    this.reconnectTimer.unref();
  }
}
