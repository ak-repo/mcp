import { createConfirmationGate } from './confirmation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createServices } from '@foodops/core';
import { openReadOnly, openWritable, type DatabaseConnection } from '@foodops/core/db/connection';
import { seedDatabase } from '@foodops/core/seed/seed';
import { AppError, ErrorCode } from '@foodops/shared';
import {
  defineTool,
  MAX_RESULT_BYTES,
  resultBytes,
  type ToolDependencies,
  type ToolExtra,
} from './define-tool.js';
import { createLogger } from './logger.js';

let directory: string;
let write: DatabaseConnection;
let read: DatabaseConnection;
let dependencies: ToolDependencies;
const extra = (signal: AbortSignal): ToolExtra => ({
  signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => {
    throw new Error('Unused request');
  },
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'foodops-wrapper-'));
  write = openWritable(join(directory, 'test.sqlite'));
  seedDatabase(write);
  read = openReadOnly(write.name);
  dependencies = {
    confirmation: createConfirmationGate(),
    services: createServices({ write, read }),
    logger: createLogger('silent'),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  read.close();
  write.close();
  rmSync(directory, { recursive: true, force: true });
});
function makeTool(execute: (signal: AbortSignal) => unknown | Promise<unknown>) {
  return defineTool({
    name: 'test_read',
    description: 'Read test data',
    inputSchema: z.strictObject({}),
    dataSchema: z.strictObject({ value: z.string() }),
    execute: (_, __, signal) => execute(signal),
    summarize: () => 'Read complete.',
    hint: 'Narrow the filters.',
  });
}
it('enforces five seconds for async work, aborts it, logs once, and cleans timers/listeners', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const tool = makeTool((value) => {
    signal = value;
    return new Promise(() => {});
  });
  const promise = tool.run({}, extra(controller.signal), dependencies);
  await vi.advanceTimersByTimeAsync(4999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await promise).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/^LIMIT_EXCEEDED:.*5 second/) }],
  });
  expect(signal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(dependencies.services.audit.listCalls().items).toHaveLength(1);
});
it('detects synchronous service overruns once control returns', async () => {
  const tool = makeTool(() => {
    vi.spyOn(performance, 'now').mockReturnValue(6000);
    return { value: 'ok' };
  });
  vi.spyOn(performance, 'now').mockReturnValue(0);
  expect(await tool.run({}, extra(new AbortController().signal), dependencies)).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/^LIMIT_EXCEEDED:/) }],
  });
});
it('honors cancellation during work and removes its listener', async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  let serviceSignal: AbortSignal | undefined;
  const tool = makeTool((signal) => {
    serviceSignal = signal;
    return new Promise(() => {});
  });
  const promise = tool.run({}, extra(controller.signal), dependencies);
  controller.abort();
  expect(await promise).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/^CONFLICT:.*cancelled/) }],
  });
  expect(serviceSignal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
  expect(dependencies.services.audit.listCalls().items[0]!.error_code).toBe('CONFLICT');
});
it('never executes an already cancelled call', async () => {
  const execute = vi.fn(() => ({ value: 'ok' }));
  const controller = new AbortController();
  controller.abort();
  expect((await makeTool(execute).run({}, extra(controller.signal), dependencies)).isError).toBe(
    true,
  );
  expect(execute).not.toHaveBeenCalled();
});
it('preserves results up to the byte limit and truncates one UTF-8 character beyond it', async () => {
  const overhead = resultBytes({
    content: [{ type: 'text', text: 'Read complete.' }],
    structuredContent: { data: { value: '' }, truncated: false },
  });
  const value = 'x'.repeat(MAX_RESULT_BYTES - overhead);
  const exact = await makeTool(() => ({ value })).run(
    {},
    extra(new AbortController().signal),
    dependencies,
  );
  expect(resultBytes(exact)).toBe(MAX_RESULT_BYTES);
  expect(exact.structuredContent).toMatchObject({ truncated: false });
  const truncated = await makeTool(() => ({ value: value + '₹' })).run(
    {},
    extra(new AbortController().signal),
    dependencies,
  );
  expect(truncated.structuredContent).toEqual({
    data: null,
    truncated: true,
    hint: 'Narrow the filters.',
  });
  expect(resultBytes(truncated)).toBeLessThan(MAX_RESULT_BYTES);
});
it('bounds AppError text while preserving its error code', async () => {
  const result = await makeTool(() => {
    throw new AppError(ErrorCode.NOT_FOUND, 'x'.repeat(30000), 'Retry');
  }).run({}, extra(new AbortController().signal), dependencies);
  expect(resultBytes(result)).toBeLessThan(MAX_RESULT_BYTES);
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/^NOT_FOUND:/) }],
  });
});
it('rejects undeclared output columns and logs INTERNAL', async () => {
  const result = await makeTool(() => ({ value: 'ok', secret: 'not a DTO field' })).run(
    {},
    extra(new AbortController().signal),
    dependencies,
  );
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/^INTERNAL:/) }],
  });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(dependencies.services.audit.listCalls().items[0]!.error_code).toBe('INTERNAL');
});
