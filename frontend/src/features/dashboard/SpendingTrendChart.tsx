import { chartAxis, chartGrid, chartTooltipStyle } from '../../lib/chartTheme'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useTranslation } from 'react-i18next'
import { fmtMoney, fmtMoneyShort, useOrgCurrency } from '../../lib/format'
import type { TrendPoint } from './useDashboardData'

export default function SpendingTrendChart({ trendData }: { trendData: TrendPoint[] }) {
  const { t } = useTranslation()
  const currency = useOrgCurrency()

  return (
    <ResponsiveContainer width="100%" height={236}>
      <AreaChart
        data={trendData}
        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
      >
        <defs>
          <linearGradient
            id="dashCostGrad"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop
              offset="0%"
              stopColor="rgb(var(--accent))"
              stopOpacity={0.12}
            />
            <stop
              offset="100%"
              stopColor="rgb(var(--accent))"
              stopOpacity={0.01}
            />
          </linearGradient>
        </defs>
        <CartesianGrid {...chartGrid}
          vertical={false}
        />
        <XAxis {...chartAxis}
          dataKey="date"
          tick={{ fill: 'rgb(var(--text-muted))', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickMargin={12}
          minTickGap={35}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis {...chartAxis}
          width={76}
          tick={{ fill: 'rgb(var(--text-muted))', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: number) => fmtMoneyShort(v, currency)}
        />
        <Tooltip
          contentStyle={chartTooltipStyle}
          formatter={(v: unknown) => [
            fmtMoney(v as number, currency),
            t('dashboard.chartCost'),
          ]}
        />
        <Area isAnimationActive={false}
          type="linear"
          dataKey="cost"
          stroke="rgb(var(--accent))"
          strokeWidth={1.75}
          fill="url(#dashCostGrad)"
          activeDot={{
            r: 5,
            stroke: 'rgb(var(--surface))',
            strokeWidth: 3,
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
