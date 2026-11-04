import { ChatRequestSchema } from '@foodops/shared';
import { expect, test } from 'vitest';

test('workspace schema parses chat input and rejects invalid shapes', () => {
  expect(ChatRequestSchema.parse({ message: 'Show late deliveries' })).toEqual({
    message: 'Show late deliveries',
  });
  expect(ChatRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
  expect(ChatRequestSchema.safeParse({ message: 'Show orders', actor: 'ops' }).success).toBe(false);
});
