const filtered = (filters: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
export const queryKeys = {
  all: ['server'] as const,
  ready: () => ['server', 'ready'] as const,
  me: () => ['server', 'me'] as const,
  orders: () => ['server', 'orders', 'list'] as const,
  orderList: (filters: Readonly<Record<string, unknown>>) =>
    ['server', 'orders', 'list', filtered(filters)] as const,
  order: (id: string) => ['server', 'orders', 'detail', id] as const,
  invoice: (id: string) => ['server', 'invoices', id] as const,
  deliveries: () => ['server', 'deliveries'] as const,
  partners: () => ['server', 'partners'] as const,
  metrics: () => ['server', 'metrics'] as const,
  metricsSummary: (filters: Readonly<Record<string, unknown>>) =>
    ['server', 'metrics', 'summary', filtered(filters)] as const,
  restaurants: () => ['server', 'restaurants'] as const,
  menu: (id: string) => ['server', 'menus', id] as const,
  mcpCalls: () => ['server', 'mcp', 'calls'] as const,
  mcpTools: () => ['server', 'mcp', 'tools'] as const,
  mcpStatus: () => ['server', 'mcp', 'status'] as const,
};
