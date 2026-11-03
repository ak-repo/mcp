import { createSimulator, type Simulator } from './simulator/simulator.js';
import { createChangeFeed, type ChangeFeed } from './events/change-feed.js';
import { createTickets } from './events/tickets.js';
import { createStreams } from './events/streams.js';
import { statSync } from 'node:fs';
import {
  createConfirmationSigner,
  type ConfirmationSigner,
  createServices,
  type Services,
} from '@foodops/core';
import { openReadOnly, openWritable, type DatabaseConnection } from '@foodops/core/db/connection';
import { AppError, ErrorCode } from '@foodops/shared';
import pino, { type Logger, type DestinationStream } from 'pino';
import type { Config } from './config.js';

export interface Runtime {
  services: Services;
  confirmation: ConfirmationSigner;
  simulator: Simulator;
  feed: ChangeFeed;
  tickets: ReturnType<typeof createTickets>;
  streams: ReturnType<typeof createStreams>;
  start(): void;
  stop(): Promise<void>;
  logger: Logger;
  checkReady(): void;
  close(): void;
}
export function createLogger(
  level: Config['LOG_LEVEL'] = 'info',
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level,
      base: { service: 'foodops-api' },
      redact: {
        paths: [
          'ADMIN_TOKEN',
          'MCP_AUTH_TOKEN',
          'MCP_CONFIRM_SECRET',
          'authorization',
          'headers.authorization',
          'req.headers.authorization',
          'config.ADMIN_TOKEN',
          'API_CONFIRM_SECRET',
          'config.API_CONFIRM_SECRET',
          'confirmation_token',
          '*.confirmation_token',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          path: request.url.split('?')[0],
        }),
      },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
export function openRuntime(config: Config): Runtime {
  let write: DatabaseConnection | undefined;
  let read: DatabaseConnection | undefined;
  try {
    if (!statSync(config.DB_PATH, { throwIfNoEntry: false })?.isFile())
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'Initialized database file was not found',
        'Run pnpm migrate and pnpm seed before starting the API',
      );
    write = openWritable(config.DB_PATH);
    read = openReadOnly(config.DB_PATH);
    const services = createServices({ write, read });
    const checkReady = () => {
      services.catalog.searchRestaurants({ limit: 1 });
    };
    checkReady();
    const logger = createLogger(config.LOG_LEVEL);
    const feed = createChangeFeed(services, logger, config.CHANGE_FEED_POLL_MS);
    const tickets = createTickets();
    const streams = createStreams(config.SSE_MAX_STREAMS);
    const simulator = createSimulator(
      services,
      logger,
      { enabled: config.SIMULATOR === 'on', interval_ms: config.SIMULATOR_INTERVAL_MS },
      config.SIMULATOR_SEED,
      { maxActive: config.SIMULATOR_MAX_ACTIVE },
    );
    let closed = false;
    return {
      services,
      confirmation: createConfirmationSigner(
        config.API_CONFIRM_SECRET ? { secret: config.API_CONFIRM_SECRET } : {},
      ),
      logger,
      feed,
      tickets,
      streams,
      simulator,
      start() {
        feed.start();
        tickets.start();
        simulator.start();
      },
      async stop() {
        await simulator.stop();
        streams.close();
        tickets.stop();
        await feed.stop();
      },
      checkReady,
      close() {
        if (closed) return;
        closed = true;
        void simulator.stop();
        streams.close();
        tickets.stop();
        void feed.stop();
        try {
          read?.close();
        } finally {
          write?.close();
        }
      },
    };
  } catch (error) {
    try {
      read?.close();
    } finally {
      write?.close();
    }
    throw error;
  }
}
