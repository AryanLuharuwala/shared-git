import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { WebSocket } from 'ws';
import type { ClaudeEvent, ControlMessage } from '@surd/shared';

// VS Code extension that surfaces the live Claude feed for a linked surd repo.
// It does NOT run the file-sync daemon — that's the CLI's job (`surd watch`).
// The extension just opens a read-only socket subscribed to the claude relay
// channel, so what each collaborator sees mirrors what every other one sees.

let feed: ClaudeFeedProvider | undefined;
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

export function activate(ctx: vscode.ExtensionContext): void {
  feed = new ClaudeFeedProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('surd.claudeFeed', feed));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('surd.openPanel', () => openPanel(ctx)),
    vscode.commands.registerCommand('surd.linkWorkspace', () => linkWorkspace()),
  );

  // Auto-connect if the workspace is already linked.
  const cfg = readRepoConfig();
  if (cfg) connect(cfg);

  ctx.subscriptions.push({ dispose: disconnect });
}

export function deactivate(): void {
  disconnect();
}

// ─── feed view ─────────────────────────────────────────────────────────────
class ClaudeFeedProvider implements vscode.TreeDataProvider<FeedItem> {
  private events: ClaudeEvent[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  append(event: ClaudeEvent): void {
    this.events.push(event);
    // Cap memory — the side panel is just a tail, not a full archive.
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    this._onDidChange.fire();
  }

  getTreeItem(item: FeedItem): vscode.TreeItem { return item; }

  getChildren(): FeedItem[] {
    // Show newest first.
    return [...this.events].reverse().map(e => new FeedItem(e));
  }
}

class FeedItem extends vscode.TreeItem {
  constructor(public readonly event: ClaudeEvent) {
    const rec = event.record as { type?: string; message?: { content?: unknown } };
    const kind = rec?.type ?? 'event';
    super(`${event.user} · ${kind}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = JSON.stringify(rec, null, 2).slice(0, 4000);
    this.description = new Date(event.ts).toLocaleTimeString();
  }
}

// ─── connection ────────────────────────────────────────────────────────────
interface RepoConfig {
  repoId: string;
  server: string;
  token: string | null;
}

function readRepoConfig(): RepoConfig | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    let gitRoot: string;
    try {
      gitRoot = cp.execSync('git rev-parse --show-toplevel', { cwd: root }).toString().trim();
    } catch { continue; }
    const cfgPath = path.join(gitRoot, '.git', 'surd', 'config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        return { repoId: raw.repoId, server: raw.server, token: raw.token };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function connect(cfg: RepoConfig): void {
  if (ws) return;
  const url = `${cfg.server.replace(/\/+$/, '')}/sync`;
  const sock = new WebSocket(url);
  ws = sock;
  sock.binaryType = 'nodebuffer';

  sock.on('open', () => {
    const hello: ControlMessage = {
      type: 'hello',
      protocol: 1,
      repoId: cfg.repoId,
      clientId: `vscode-${process.pid}`,
      user: process.env.USER ?? 'vscode',
      token: cfg.token ?? undefined,
    };
    sock.send(JSON.stringify(hello));
    sock.send(JSON.stringify({ type: 'subscribeClaude' } satisfies ControlMessage));
    vscode.window.setStatusBarMessage(`surd: connected to ${cfg.server}`, 3000);
  });

  sock.on('message', (data, isBinary) => {
    if (isBinary) return; // Extension doesn't participate in Yjs sync.
    try {
      const msg = JSON.parse(data.toString('utf8')) as ControlMessage;
      if (msg.type === 'claudeEvent') feed?.append(msg.event);
      else if (msg.type === 'error') {
        vscode.window.showErrorMessage(`surd: ${msg.message}`);
      }
    } catch { /* ignore */ }
  });

  sock.on('close', () => {
    ws = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        const fresh = readRepoConfig();
        if (fresh) connect(fresh);
      }, 3_000);
    }
  });

  sock.on('error', err => console.error('surd: socket error', err));
}

function disconnect(): void {
  ws?.close();
  ws = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ─── commands ──────────────────────────────────────────────────────────────
async function linkWorkspace(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('surd: open a folder first');
    return;
  }
  const server = await vscode.window.showInputBox({
    prompt: 'surd server URL',
    value: vscode.workspace.getConfiguration('surd').get<string>('server') ?? 'ws://localhost:4455',
  });
  if (!server) return;
  const terminal = vscode.window.createTerminal({ name: 'surd link', cwd: folders[0].uri.fsPath });
  terminal.sendText(`surd link ${server}`);
  terminal.show();
}

function openPanel(ctx: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    'surdClaude', 'Surd · Live Claude Sessions', vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = `
    <!doctype html><html><body style="font-family: sans-serif; padding: 12px">
      <h2>Surd live Claude feed</h2>
      <p>The Explorer view "Surd — Live Claude Feed" shows incoming messages
        from every collaborator working in this repo.</p>
      <p>If you don't see anything: run <code>surd link &lt;server&gt;</code>
        and then <code>surd watch</code> in this repo.</p>
    </body></html>
  `;
  ctx.subscriptions.push(panel);
}
