import { z } from 'zod';
import { definePrompt } from './define-prompt.js';

export const prompt = definePrompt({
  name: 'order_triage',
  description:
    'Investigate active orders, identify late or stuck work, and propose approved operational actions.',
  inputSchema: z.strictObject({}),
  instructions: () =>
    'Use food://schema and food://policies/cancellation-refund as references. Call list_orders for active statuses and follow every next_cursor needed for the investigation. Use get_order and track_delivery to inspect timelines, payment failures, missing partners, and is_late. Group observed issues by cause; cite order IDs and evidence, and do not invent lateness thresholds or missing facts. Use list_delivery_partners before proposing a reassignment. Present proposed actions and their previews before seeking explicit user approval. Do not execute writes during the investigation.',
});
