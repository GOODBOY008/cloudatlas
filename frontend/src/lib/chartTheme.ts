/** Shared analytics styling. CSS tokens update existing SVG charts with the theme. */
export const chartColors = {
  blue: 'rgb(var(--chart-1))',
  orange: 'rgb(var(--chart-2))',
  cyan: 'rgb(var(--chart-3))',
  purple: 'rgb(var(--chart-4))',
  green: 'rgb(var(--chart-5))',
  pink: 'rgb(var(--chart-6))',
  danger: 'rgb(var(--danger))',
  muted: 'rgb(var(--text-muted))',
} as const

export const chartPalette = [
  chartColors.blue, chartColors.orange, chartColors.cyan,
  chartColors.purple, chartColors.green, chartColors.pink,
]

export const chartAxis = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  tick: { fill: 'rgb(var(--text-muted))', fontSize: 11 },
}

export const chartGrid = {
  stroke: 'rgb(var(--border))',
  strokeDasharray: '2 3',
}

export const chartTooltipStyle = {
  background: 'rgb(var(--surface))',
  border: '1px solid rgb(var(--border-strong))',
  borderRadius: 4,
  color: 'rgb(var(--text-primary))',
  fontSize: 12,
}

export const providerChartColors: Record<string, string> = {
  aws: chartColors.orange,
  alibaba: chartColors.orange,
  azure: chartColors.blue,
  gcp: chartColors.green,
  kubernetes: chartColors.purple,
  unknown: chartColors.muted,
}
