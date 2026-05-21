// Wire protocol shared between surd server and clients.
//
// Transport: one WebSocket per (client, repo). Messages are framed as
// `[type:u8, ...payload]` binary frames for sync traffic, or JSON text frames
// for control/Claude traffic. Mixing keeps Yjs binary deltas efficient while
// still letting us send human-readable control messages.

export const PROTOCOL_VERSION = 1;

// Binary frame types (first byte of a binary message).
export enum BinaryFrame {
  YjsSync = 0,        // Yjs sync protocol frame (y-protocols/sync)
  YjsAwareness = 1,   // Yjs awareness frame (y-protocols/awareness)
}

// JSON control messages (sent as text frames).
export type ControlMessage =
  | { type: 'hello'; protocol: number; repoId: string; clientId: string; user: string; token?: string }
  | { type: 'welcome'; serverId: string; commit: string | null; branch: string | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'commit'; commit: string; branch: string; author: string; message: string; ts: number }
  | { type: 'branchChanged'; branch: string; commit: string }
  | { type: 'claudeEvent'; event: ClaudeEvent }
  | { type: 'subscribeClaude'; sessionId?: string }
  | { type: 'presence'; user: string; cursor?: { path: string; line: number; col: number } };

// A single line from a Claude Code session JSONL file, plus metadata we need
// to route it to the right collaborators.
export interface ClaudeEvent {
  repoId: string;
  sessionId: string;     // Claude session UUID
  user: string;          // collaborator who produced/observed it
  seq: number;           // monotonic per session — used to dedupe
  ts: number;            // epoch ms
  // Raw JSONL record as written by Claude Code. Kept opaque so the protocol
  // doesn't have to evolve every time Claude Code adds new record types.
  record: unknown;
}

export interface RepoDescriptor {
  id: string;            // stable id, usually `${gitRemote}#${repoSlug}`
  gitRemote: string;     // canonical git remote URL
  defaultBranch: string;
  createdAt: number;
}

// Helper: encode/decode a binary frame with a leading type byte.
export function encodeBinary(type: BinaryFrame, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export function decodeBinary(frame: Uint8Array): { type: BinaryFrame; payload: Uint8Array } {
  return { type: frame[0] as BinaryFrame, payload: frame.subarray(1) };
}
