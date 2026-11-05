import {
  BarChart,
  Bar,
  CartesianGrid,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Point = { key: string; orders: number; gmv: number };
export function OverviewCharts({
  daily,
  status,
  restaurants,
}: {
  daily: Point[];
  status: Point[];
  restaurants: Point[];
}) {
  return (
    <div className="chart-grid">
      <section className="card chart-card">
        <header className="card-header">
          <h2 className="card-title">Orders and GMV · UTC</h2>
        </header>
        <div className="chart-body">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="key" />
              <YAxis yAxisId="orders" />
              <YAxis yAxisId="gmv" orientation="right" />
              <Tooltip />
              <Line
                yAxisId="orders"
                type="monotone"
                dataKey="orders"
                stroke="var(--accent)"
                strokeWidth={2}
              />
              <Line
                yAxisId="gmv"
                type="monotone"
                dataKey="gmv"
                stroke="var(--accepted-fg)"
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="card chart-card">
        <header className="card-header">
          <h2 className="card-title">Orders by status</h2>
        </header>
        <div className="chart-body">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={status}
                dataKey="orders"
                nameKey="key"
                cx="50%"
                cy="50%"
                outerRadius={90}
                label
              >
                {status.map((entry, index) => (
                  <Cell
                    key={entry.key}
                    fill={
                      [
                        'var(--accepted-fg)',
                        'var(--preparing-fg)',
                        'var(--ready-fg)',
                        'var(--delivered-fg)',
                        'var(--cancelled-fg)',
                      ][index % 5]
                    }
                  />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="card chart-card chart-wide">
        <header className="card-header">
          <h2 className="card-title">Revenue by restaurant · top 8</h2>
        </header>
        <div className="chart-body">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={restaurants} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" />
              <YAxis type="category" dataKey="key" width={110} />
              <Tooltip />
              <Bar dataKey="gmv" fill="var(--accent)" radius={[0, 5, 5, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
