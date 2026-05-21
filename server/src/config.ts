import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  // If set, clients must present this bearer token in their `hello` message.
  authToken: string | null;
  // How long an idle Yjs doc stays in memory before being flushed and unloaded.
  docIdleMs: number;
}

export function loadConfig(): ServerConfig {
  const dataDir = resolve(process.env.SURD_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(resolve(dataDir, 'docs'), { recursive: true });

  return {
    port: Number(process.env.SURD_PORT ?? 4455),
    host: process.env.SURD_HOST ?? '0.0.0.0',
    dataDir,
    authToken: process.env.SURD_TOKEN ?? null,
    docIdleMs: Number(process.env.SURD_DOC_IDLE_MS ?? 5 * 60_000),
  };
}
