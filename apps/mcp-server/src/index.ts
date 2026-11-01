export { createServer } from './lib/create-server.js';
export { loadConfig, ConfigSchema, type Config } from './lib/config.js';
export { createLogger } from './lib/logger.js';

import { startStdio } from './transports/stdio.js';
import { isMain, runCli } from './transports/runtime.js';
if (isMain(import.meta.url)) await runCli((config) => startStdio({ config }));
