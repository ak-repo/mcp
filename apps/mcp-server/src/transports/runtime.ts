import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServices, type Services } from '@foodops/core';
import { openReadOnly, openWritable, type DatabaseConnection } from '@foodops/core/db/connection';
import { AppError, ErrorCode } from '@foodops/shared';
import type { Logger } from 'pino';
import { loadConfig, type Config } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { asAppError } from '../lib/error-mapper.js';

export const DRAIN_TIMEOUT_MS = 10000;
export interface Runtime {
  services: Services;
  logger: Logger;
  checkHealth(): void;
  close(): void;
}
export function openRuntime(config: Config): Runtime {
  let write: DatabaseConnection | undefined;
  let read: DatabaseConnection | undefined;
  try {
    if (!statSync(config.DB_PATH, { throwIfNoEntry: false })?.isFile())
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'Initialized database file was not found',
        'Run pnpm migrate and pnpm seed before starting MCP',
      );
    write = openWritable(config.DB_PATH);
    read = openReadOnly(config.DB_PATH);
    const services = createServices({ write, read });
    const checkHealth = () => {
      services.catalog.searchRestaurants({ limit: 1 });
    };
    checkHealth();
    services.order.listOrders({ limit: 1 });
    services.audit.listCalls({ limit: 1 });
    let closed = false;
    return {
      services,
      logger: createLogger(config.LOG_LEVEL),
      checkHealth,
      close() {
        if (closed) return;
        closed = true;
        read?.close();
        write?.close();
      },
    };
  } catch (error) {
    read?.close();
    write?.close();
    throw error;
  }
}
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === url;
}
export function correlation(value: unknown, fallback: string = randomUUID()): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback;
}
export function installSignals(shutdown: () => Promise<void>, logger: Logger): () => void {
  const handler = () => {
    void shutdown().catch(() => {
      logger.error('Graceful shutdown failed');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
export async function runCli(start: (config: Config) => Promise<unknown>): Promise<void> {
  try {
    await start(loadConfig());
  } catch (error) {
    createLogger().error({ error: asAppError(error).toToolText() }, 'MCP startup failed');
    process.exitCode = 1;
  }
}
export async function drain(pending: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
