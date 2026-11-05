import { describe, expect, it } from 'vitest';
import { filterDeliveries } from './filter-utils.js';

const rows = [
  { order_id: 'O-1', is_late: true, delivery: { partner_id: 'DP-1' } },
  { order_id: 'O-2', is_late: false, delivery: { partner_id: null } },
];

describe('delivery filters', () => {
  it('combines late, unassigned and search filters', () => {
    expect(filterDeliveries(rows, { lateOnly: true, unassigned: false, search: '' })).toHaveLength(
      1,
    );
    expect(filterDeliveries(rows, { lateOnly: false, unassigned: true, search: 'o-2' })).toEqual([
      rows[1],
    ]);
  });
});
