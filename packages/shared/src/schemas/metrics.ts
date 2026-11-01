import { z } from 'zod';
import { DateBoundarySchema, PaiseSchema, TextSchema, validateDateRange } from './common.js';

export const SalesGroupBySchema = z.enum(['day', 'restaurant', 'status']);
export type SalesGroupBy = z.infer<typeof SalesGroupBySchema>;
export const SalesSummaryFiltersSchema = z
  .strictObject({
    from: DateBoundarySchema,
    to: DateBoundarySchema,
    group_by: SalesGroupBySchema,
  })
  .superRefine(validateDateRange);
export type SalesSummaryFilters = z.infer<typeof SalesSummaryFiltersSchema>;

/** cancel_rate is a fraction in [0, 1]; delivery time is null when there are no completed deliveries. */
export const SummaryMetricsSchema = z.strictObject({
  orders: z.number().int().nonnegative(),
  gmv_paise: PaiseSchema,
  gmv_display: TextSchema,
  avg_order_value_paise: PaiseSchema,
  avg_order_value_display: TextSchema,
  cancel_rate: z.number().min(0).max(1),
  avg_delivery_time_min: z.number().nonnegative().nullable(),
});
export type SummaryMetrics = z.infer<typeof SummaryMetricsSchema>;
export const SalesSummaryGroupSchema = SummaryMetricsSchema.extend({ key: TextSchema });
export type SalesSummaryGroup = z.infer<typeof SalesSummaryGroupSchema>;
export const SalesSummarySchema = z
  .strictObject({
    from: DateBoundarySchema,
    to: DateBoundarySchema,
    group_by: SalesGroupBySchema,
    totals: SummaryMetricsSchema,
    groups: z.array(SalesSummaryGroupSchema),
  })
  .superRefine(validateDateRange);
export type SalesSummary = z.infer<typeof SalesSummarySchema>;
