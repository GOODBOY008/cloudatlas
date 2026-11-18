/** Non-interactive summary metric; status colors belong to the supporting value. */
export function MetricCard({ label, value, detail }: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="panel min-w-0 p-5">
      <p className="text-xs font-medium text-secondary">{label}</p>
      <p className="metric-value">{value}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted">{detail}</p>
    </div>
  )
}
