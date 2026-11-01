import { startApi } from '../index.js';
import { loadConfig } from '../config.js';
// Child-process fixture: the public CLI has no test-only environment switches.
const application = await startApi({
  config: loadConfig(),
  port: 0,
  drainMs: process.argv[2] === 'timeout' ? 50 : 10000,
});
process.stdout.write(`${JSON.stringify({ api_test_url: application.url })}\n`);
