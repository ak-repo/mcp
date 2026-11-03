import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ErrorCode,
  ProviderUpdateSchema,
  ProviderPublicConfigSchema,
  ProvidersResponseSchema,
  ModelListSchema,
  ProbeResultSchema,
} from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { validate } from '../lib/validate.js';
import { UpstreamHttpError, HttpError } from '../lib/http-errors.js';
import { LLMError } from '../llm/errors.js';
const empty = z.strictObject({});
function upstream(error: unknown): never {
  const kind = error instanceof LLMError ? error.kind : 'provider_error';
  const message =
    kind === 'auth'
      ? 'Provider API key is missing or invalid'
      : kind === 'rate_limit'
        ? 'Provider is rate limited'
        : kind === 'model_not_found'
          ? 'Configured model was not found'
          : kind === 'timeout'
            ? 'Provider response timed out'
            : 'Provider is unavailable';
  throw new UpstreamHttpError(
    message,
    kind === 'auth'
      ? 'Update the provider API key'
      : kind === 'rate_limit'
        ? 'Wait before probing or generating again'
        : 'Check provider settings, model identifier, and connectivity',
  );
}
const providers: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime }) => {
  const manager = runtime.agent.providers;
  app.get('/providers', async (request) => {
    validate(empty, request.query);
    return ProvidersResponseSchema.parse({
      ...manager.publicView(),
      last_probe: manager.lastProbe(),
    });
  });
  app.put('/providers', { preHandler: app.writeRateLimit }, async (request) => {
    validate(empty, request.query);
    const patch = validate(ProviderUpdateSchema, request.body);
    try {
      return ProviderPublicConfigSchema.parse(manager.update(patch));
    } catch (error) {
      if (error instanceof LLMError && error.kind === 'bad_request')
        throw new HttpError(
          400,
          ErrorCode.VALIDATION,
          'Invalid provider settings',
          'Check base URL, model, generation values, and key format',
        );
      throw error;
    }
  });
  app.get('/providers/models', async (request) => {
    validate(empty, request.query);
    try {
      return ModelListSchema.parse({
        models: (await manager.provider.listModels(runtime.signal)).map((model) => ({
          ...model,
          name: manager.redact(model.name),
        })),
      });
    } catch (error) {
      upstream(error);
    }
  });
  app.post('/providers/test', { preHandler: app.probeRateLimit }, async (request) => {
    validate(empty, request.query);
    validate(empty.optional(), request.body);
    let result;
    try {
      result = ProbeResultSchema.parse(await manager.probe(runtime.signal));
    } catch (error) {
      upstream(error);
    }
    if (!result.ok) {
      const detail =
        result.steps.find((step) => !step.ok)?.detail ?? 'Provider capability check failed';
      throw new UpstreamHttpError(
        detail,
        !result.model_found
          ? 'Check API credentials and choose an available model identifier'
          : 'Check model tool support or select prompted mode',
      );
    }
    return result;
  });
};
export default providers;
