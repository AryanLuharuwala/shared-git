#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { BinaryFrame, decodeBinary, type ControlMessage } from '@surd/shared';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { Hub } from './hub.js';
import { ClaudeRelay } from './claude-relay.js';

const config = loadConfig();
const storage = new Storage(config);
const hub = new Hub(storage, config);
const relay = new ClaudeRelay(storage);
const serverId = uuid();

const http = createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  // Only one path is meaningful for now: /sync. Repo/branch arrive in the
  // `hello` JSON, not the URL, so we can route a single socket to multiple
  // streams if we ever want to.
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/sync') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => handleSocket(ws));
});

http.listen(config.port, config.host, () => {
  console.log(`[surd] server ${serverId} listening on ws://${config.host}:${config.port}/sync`);
  console.log(`[surd] data dir: ${config.dataDir}`);
  if (!config.authToken) console.log(`[surd] WARN: no SURD_TOKEN set — accepting all clients`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown(): void {
  console.log('[surd] shutting down');
  hub.shutdown();
  wss.close();
  http.close();
  setTimeout(() => process.exit(0), 500).unref();
}

// ─── HTTP API ──────────────────────────────────────────────────────────────
// Small REST surface so the CLI can register repos and post commits without
// keeping a socket open. Everything sync-related goes over WS.
function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, serverId, repos: storage.listRepos().length });
  }
  if (req.method === 'GET' && url.pathname === '/repos') {
    return json(res, 200, storage.listRepos());
  }
  if (req.method === 'POST' && url.pathname === '/repos') {
    return readJson(req, body => {
      const { id, gitRemote, defaultBranch } = body as {
        id?: string; gitRemote?: string; defaultBranch?: string;
      };
      if (!id || !gitRemote) return json(res, 400, { error: 'id and gitRemote required' });
      storage.upsertRepo({
        id,
        git_remote: gitRemote,
        default_branch: defaultBranch ?? 'main',
        created_at: Date.now(),
      });
      json(res, 200, { ok: true });
    });
  }
  if (req.method === 'POST' && url.pathname === '/commits') {
    return readJson(req, body => {
      const { repoId, branch, commit, author, message } = body as {
        repoId?: string; branch?: string; commit?: string; author?: string; message?: string;
      };
      if (!repoId || !branch || !commit) {
        return json(res, 400, { error: 'repoId, branch, commit required' });
      }
      storage.recordCommit({
        repo_id: repoId,
        branch,
        commit_sha: commit,
        author: author ?? 'unknown',
        message: message ?? '',
        ts: Date.now(),
      });
      json(res, 200, { ok: true });
    });
  }
  json(res, 404, { error: 'not found' });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, cb: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c as Buffer));
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      cb(raw.length === 0 ? {} : JSON.parse(raw));
    } catch (err) {
      console.error('[surd] bad json body', err);
    }
  });
}

// ─── WebSocket session ─────────────────────────────────────────────────────
// Each socket goes through three phases:
//   1. waiting for `hello`
//   2. subscribed to a doc — handles sync + awareness + claude
//   3. closing — release subscriptions

type SessionState =
  | { phase: 'init' }
  | {
      phase: 'live';
      repoId: string;
      branch: string;
      user: string;
      live: ReturnType<Hub['acquire']>;
      claudeSub: { ws: WebSocket; user: string } | null;
    };

function handleSocket(ws: WebSocket): void {
  let state: SessionState = { phase: 'init' };
  const helloTimer = setTimeout(() => {
    if (state.phase === 'init') {
      send(ws, { type: 'error', code: 'no_hello', message: 'hello required within 5s' });
      ws.close();
    }
  }, 5_000);
  helloTimer.unref();

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) return onBinary(data as Buffer);
      onText(data.toString('utf8'));
    } catch (err) {
      console.error('[surd] socket error', err);
      send(ws, { type: 'error', code: 'internal', message: String(err) });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (state.phase === 'live') {
      hub.release(state.live, ws);
      if (state.claudeSub) relay.unsubscribe(state.repoId, state.claudeSub);
    }
  });

  function onBinary(buf: Buffer): void {
    if (state.phase !== 'live') return;
    const { type, payload } = decodeBinary(new Uint8Array(buf));
    if (type === BinaryFrame.YjsSync) hub.handleSync(state.live, payload, ws);
    else if (type === BinaryFrame.YjsAwareness) hub.handleAwareness(state.live, payload, ws);
  }

  function onText(text: string): void {
    const msg = JSON.parse(text) as ControlMessage;
    switch (msg.type) {
      case 'hello': return handleHello(msg);
      case 'subscribeClaude': return handleSubscribeClaude(msg);
      case 'claudeEvent': return handleClaudeEvent(msg);
      case 'commit': return handleCommitNotice(msg);
      case 'presence': /* awareness covers this; ignore */ return;
      default:
        send(ws, { type: 'error', code: 'unknown_message', message: `unknown type ${(msg as { type: string }).type}` });
    }
  }

  function handleHello(msg: Extract<ControlMessage, { type: 'hello' }>): void {
    if (config.authToken && msg.token !== config.authToken) {
      send(ws, { type: 'error', code: 'unauthorized', message: 'bad token' });
      ws.close();
      return;
    }
    const repo = storage.getRepo(msg.repoId);
    if (!repo) {
      send(ws, { type: 'error', code: 'unknown_repo', message: `register ${msg.repoId} first via POST /repos` });
      ws.close();
      return;
    }
    // We default to syncing the default branch — multi-branch live sync would
    // need separate doc subscriptions, which the protocol allows but we keep
    // simple for the MVP: one doc per socket.
    const branch = repo.default_branch;
    const live = hub.acquire(msg.repoId, branch, ws);
    state = {
      phase: 'live',
      repoId: msg.repoId,
      branch,
      user: msg.user || msg.clientId,
      live,
      claudeSub: null,
    };
    const head = storage.branchHead(msg.repoId, branch);
    send(ws, { type: 'welcome', serverId, commit: head.commit, branch });
    hub.sendInitialSync(live, ws);
  }

  function handleSubscribeClaude(_msg: Extract<ControlMessage, { type: 'subscribeClaude' }>): void {
    if (state.phase !== 'live') return;
    const sub = { ws, user: state.user };
    relay.subscribe(state.repoId, sub);
    state.claudeSub = sub;
    // Replay the last 30 minutes of activity so panels boot warm.
    relay.replayRecent(state.repoId, 30 * 60_000, ws);
  }

  function handleClaudeEvent(msg: Extract<ControlMessage, { type: 'claudeEvent' }>): void {
    if (state.phase !== 'live') return;
    // Trust the event's repoId but override the user with the authenticated
    // session's user so a client can't spoof messages.
    relay.ingest({ ...msg.event, repoId: state.repoId, user: state.user });
  }

  function handleCommitNotice(msg: Extract<ControlMessage, { type: 'commit' }>): void {
    if (state.phase !== 'live') return;
    storage.recordCommit({
      repo_id: state.repoId,
      branch: msg.branch,
      commit_sha: msg.commit,
      author: msg.author,
      message: msg.message,
      ts: msg.ts,
    });
    // Broadcast to every other subscriber of the same repo via the claude
    // relay channel set (cheap reuse of the per-repo connection registry).
    // For the MVP we just rely on clients polling /repos for branch heads.
  }
}

function send(ws: WebSocket, msg: ControlMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
