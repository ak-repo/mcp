import { z } from 'zod';
import { IdSchema, TextSchema, TimestampSchema } from './common.js';

export const CustomerSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  phone: TextSchema,
  email: z.email(),
  created_at: TimestampSchema,
});
export type Customer = z.infer<typeof CustomerSchema>;

export const AddressSchema = z.strictObject({
  id: IdSchema,
  customer_id: IdSchema,
  label: TextSchema,
  line1: TextSchema,
  area: TextSchema,
  city: TextSchema,
  pincode: z.string().regex(/^[1-9][0-9]{5}$/),
});
export type Address = z.infer<typeof AddressSchema>;
