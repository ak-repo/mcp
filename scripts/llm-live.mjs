#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
const { AbortController } = globalThis;
// Explicitly opt in: this script contacts the configured provider and may incur usage.
if (process.env.LLM_LIVE !== '1') {
  console.error('Live LLM check is disabled. Set LLM_LIVE=1 to opt in, and build first.');
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let key;
  let redact;
  try {
    const configuration = await import('../apps/api/dist/config.js');
    const llm = await import('../apps/api/dist/llm/index.js');
    redact = llm.redact;
    const config = configuration.loadConfig({
      env: {
        ...process.env,
        ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'llm-live-does-not-start-an-http-server',
      },
    });
    key = config.LLM_API_KEY;
    if (config.LLM_PROVIDER !== 'ollama')
      throw new llm.LLMError('bad_request', 'This live check requires LLM_PROVIDER=ollama', false);
    const provider = llm.createOllamaProvider(config);
    const print = (value) => console.log(llm.redact(JSON.stringify(value), key ? [key] : []));
    print({ models: await provider.listModels(controller.signal) });
    let called = false;
    for await (const event of provider.chat(
      [
        {
          role: 'user',
          content:
            'Call foodops_live_echo exactly once with value "ping". Do not answer in prose. This is a harmless connectivity check.',
        },
      ],
      [
        {
          name: 'foodops_live_echo',
          description: 'A harmless test tool that echoes a value. Request it once with value ping.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string', enum: ['ping'] } },
            required: ['value'],
          },
        },
      ],
      { maxTokens: 256, signal: controller.signal },
    )) {
      print(event);
      if (event.type === 'tool_call') {
        if (event.name !== 'foodops_live_echo' || event.arguments.value !== 'ping' || called)
          throw new llm.LLMError(
            'provider_error',
            'Live model returned an unexpected tool call',
            false,
          );
        called = true;
      }
    }
    if (!called)
      throw new llm.LLMError(
        'provider_error',
        'Live model did not request the test tool; use a tool-capable model',
        false,
      );
    print({ ok: true, tool_executed: false });
  } catch (error) {
    const safe =
      error && typeof error === 'object' && ['LLMError', 'AppError'].includes(error.name)
        ? String(error.message)
        : 'Live LLM check failed; build the workspace and check LLM configuration';
    console.error(
      redact ? redact(safe, key ? [key] : []) : 'Live LLM check could not load the built modules',
    );
    process.exitCode = 1;
  } finally {
    controller.abort();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
