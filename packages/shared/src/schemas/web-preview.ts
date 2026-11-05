import { z } from 'zod';
import {
  AdvancePreviewSchema,
  CancelPreviewSchema,
  RefundPreviewSchema,
  ReassignPreviewSchema,
} from './responses.js';

const confirmation = {
  confirmation_token: z.string().max(2048),
  expires_at: z.string().datetime(),
};

/** REST preview responses after the server signs the preview for execution. */
export const AdvancePreviewResponseSchema = AdvancePreviewSchema.extend(confirmation);
export const CancelPreviewResponseSchema = CancelPreviewSchema.extend(confirmation);
export const RefundPreviewResponseSchema = RefundPreviewSchema.extend(confirmation);
export const ReassignPreviewResponseSchema = ReassignPreviewSchema.extend(confirmation);

export type AdvancePreviewResponse = z.infer<typeof AdvancePreviewResponseSchema>;
export type CancelPreviewResponse = z.infer<typeof CancelPreviewResponseSchema>;
export type RefundPreviewResponse = z.infer<typeof RefundPreviewResponseSchema>;
export type ReassignPreviewResponse = z.infer<typeof ReassignPreviewResponseSchema>;
