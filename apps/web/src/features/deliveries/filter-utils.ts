export function filterDeliveries<
  T extends { order_id: string; is_late: boolean; delivery: { partner_id: string | null } | null },
>(rows: T[], options: { lateOnly: boolean; unassigned: boolean; search: string }) {
  const search = options.search.toLowerCase();
  return rows.filter(
    (row) =>
      (!options.lateOnly || row.is_late) &&
      (!options.unassigned || row.delivery?.partner_id === null) &&
      (!search || row.order_id.toLowerCase().includes(search)),
  );
}
