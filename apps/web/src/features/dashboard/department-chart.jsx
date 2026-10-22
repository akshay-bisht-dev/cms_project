'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium text-foreground">{row.name}</p>
      <p className="text-muted-foreground">
        {row.count} active {row.count === 1 ? 'person' : 'people'}
      </p>
    </div>
  );
}

/**
 * Active people per department: one series, one hue, horizontal bars (labels stay readable).
 * A visually hidden table carries the same data for screen readers.
 */
export function DepartmentChart({ data }) {
  const height = Math.max(160, data.length * 36 + 40);
  return (
    <figure>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          {/* The chart is decorative for assistive tech (the table below carries the data), so it must not take focus. */}
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }} barCategoryGap={8} accessibilityLayer={false}>
            <CartesianGrid horizontal={false} stroke="var(--border)" strokeWidth={1} />
            <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
            <YAxis type="category" dataKey="name" width={140} tickLine={false} axisLine={false} tick={{ fill: 'var(--foreground)', fontSize: 12 }} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--muted)' }} />
            <Bar dataKey="count" fill="var(--primary)" barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Active people by department</caption>
        <thead>
          <tr>
            <th scope="col">Department</th>
            <th scope="col">Active people</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.departmentId ?? 'unassigned'}>
              <td>{row.name}</td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
