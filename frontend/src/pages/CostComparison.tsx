import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { SelectField } from '../components/shared/SelectField'
import { cloudServiceLabel } from '../lib/objectStorage'
import { chartColors, chartAxis, chartGrid } from '../lib/chartTheme'
import { fmtMoney, fmtMoneyShort, useOrgCurrency } from '../lib/format'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ExpenseAgg { name: string; total_cost: number }

// Backend returns {service_name|region|account_name|pool_name, cost} depending on endpoint
function normalizeAgg(item: Record<string, unknown>): ExpenseAgg {
  const name = item.name ?? item.service_name ?? item.region ?? item.account_name ?? item.pool_name
  const total = Number(item.total_cost ?? item.cost ?? 0)
  return { name: name ? String(name) : 'Unknown', total_cost: Number.isFinite(total) ? total : 0 }
}

const DIM_OPTIONS = [
  { labelKey: 'costComparison.dimService', headerKey: 'costComparison.colService', endpoint: 'by-service', key: 'name' },
  { labelKey: 'costComparison.dimRegion', headerKey: 'costComparison.colRegion', endpoint: 'by-region', key: 'name' },
  { labelKey: 'costComparison.dimCloud', headerKey: 'costComparison.colCloud', endpoint: 'by-cloud', key: 'name' },
  { labelKey: 'costComparison.dimPool', headerKey: 'costComparison.colPool', endpoint: 'by-pool', key: 'name' },
]

function daysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10)
}
function today() { return new Date().toISOString().slice(0, 10) }

export default function CostComparison() {
  const currency = useOrgCurrency()
  const fmt = (value: number) => fmtMoney(value, currency)
  const fmtShort = (value: number) => fmtMoneyShort(value, currency)
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''

  const [dim, setDim] = useState(DIM_OPTIONS[0])
  const [periodA, setPeriodA] = useState({ start: daysAgo(60), end: daysAgo(31) })
  const [periodB, setPeriodB] = useState({ start: daysAgo(30), end: today() })

  const params = (p: typeof periodA) => `start_date=${p.start}&end_date=${p.end}`

  const { data: dataA } = useQuery({
    queryKey: ['compare-a', orgId, dim.endpoint, periodA],
    queryFn: () => api.get<{ data: Record<string, unknown>[] }>(`/orgs/${orgId}/expenses/${dim.endpoint}?${params(periodA)}`).then(r => (r.data.data ?? []).map(normalizeAgg)),
    enabled: !!orgId,
  })

  const { data: dataB } = useQuery({
    queryKey: ['compare-b', orgId, dim.endpoint, periodB],
    queryFn: () => api.get<{ data: Record<string, unknown>[] }>(`/orgs/${orgId}/expenses/${dim.endpoint}?${params(periodB)}`).then(r => (r.data.data ?? []).map(normalizeAgg)),
    enabled: !!orgId,
  })

  // Merge both datasets
  const allKeys = Array.from(new Set([...(dataA ?? []).map(d => d.name), ...(dataB ?? []).map(d => d.name)]))
  const mapA = Object.fromEntries((dataA ?? []).map(d => [d.name, d.total_cost]))
  const mapB = Object.fromEntries((dataB ?? []).map(d => [d.name, d.total_cost]))

  const merged = allKeys.map(k => {
    const label = dim.endpoint === 'by-service' ? cloudServiceLabel(k) : k
    return {
      key: k,
      name: label?.slice(0, 16) ?? t('status.unknown'),
      full_name: label,
      period_a: mapA[k] ?? 0,
      period_b: mapB[k] ?? 0,
      delta: (mapB[k] ?? 0) - (mapA[k] ?? 0),
      delta_pct: mapA[k] > 0 ? (((mapB[k] ?? 0) - mapA[k]) / mapA[k]) * 100 : 0,
    }
  }).sort((a, b) => b.period_b - a.period_b)

  const totalA = (dataA ?? []).reduce((s, d) => s + d.total_cost, 0)
  const totalB = (dataB ?? []).reduce((s, d) => s + d.total_cost, 0)
  const totalDelta = totalB - totalA
  const totalDeltaPct = totalA > 0 ? (totalDelta / totalA) * 100 : 0

  return (
    <div className="space-y-6">
      <div className="page-heading">
        <h1 className="page-title">{t('costComparison.title')}</h1>
        <p className="text-sm text-secondary mt-1">{t('costComparison.subtitle')}</p>
      </div>

      {/* Period pickers + dimension */}
      <div className="bg-surface rounded-xl border border-strong p-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="text-xs text-secondary mb-2 block">{t('costComparison.periodABaseline')}</label>
            <div className="flex gap-2">
              <Input type="date" aria-label={`${t('costComparison.periodABaseline')} · ${t('biExport.startDate')}`} value={periodA.start} onChange={e => setPeriodA(p => ({ ...p, start: e.target.value }))}
                className="flex-1" />
              <Input type="date" aria-label={`${t('costComparison.periodABaseline')} · ${t('biExport.endDate')}`} value={periodA.end} onChange={e => setPeriodA(p => ({ ...p, end: e.target.value }))}
                className="flex-1" />
            </div>
          </div>
          <div>
            <label className="text-xs text-secondary mb-2 block">{t('costComparison.periodBComparison')}</label>
            <div className="flex gap-2">
              <Input type="date" aria-label={`${t('costComparison.periodBComparison')} · ${t('biExport.startDate')}`} value={periodB.start} onChange={e => setPeriodB(p => ({ ...p, start: e.target.value }))}
                className="flex-1" />
              <Input type="date" aria-label={`${t('costComparison.periodBComparison')} · ${t('biExport.endDate')}`} value={periodB.end} onChange={e => setPeriodB(p => ({ ...p, end: e.target.value }))}
                className="flex-1" />
            </div>
          </div>
          <div>
            <SelectField
              label={t('costComparison.groupBy')}
              value={dim.labelKey}
              onValueChange={value => setDim(DIM_OPTIONS.find(d => d.labelKey === value) ?? DIM_OPTIONS[0])}
              className="w-full"
              items={DIM_OPTIONS.map(d => ({ value: d.labelKey, label: t(d.labelKey) }))}
            />
          </div>
        </div>
      </div>

      {/* Summary delta cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('costComparison.periodATotal')}</p>
          <p className="text-2xl font-semibold text-accent mt-1">{fmtShort(totalA)}</p>
          <p className="text-xs text-muted mt-1">{periodA.start} → {periodA.end}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('costComparison.periodBTotal')}</p>
          <p className="text-2xl font-semibold text-primary mt-1">{fmtShort(totalB)}</p>
          <p className="text-xs text-muted mt-1">{periodB.start} → {periodB.end}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('costComparison.change')}</p>
          <p className={`text-2xl font-semibold mt-1 ${totalDelta > 0 ? 'text-danger' : 'text-success'}`}>
            {totalDelta > 0 ? '+' : ''}{fmtShort(totalDelta)}
          </p>
          <p className={`text-xs mt-1 ${totalDelta > 0 ? 'text-danger' : 'text-success'}`}>
            {totalDelta > 0 ? '+' : ''}{t('costComparison.vsBaseline', { percent: totalDeltaPct.toFixed(1) })}
          </p>
        </div>
      </div>

      {/* Side-by-side bar chart */}
      {merged.length > 0 && (
        <div className="bg-surface rounded-xl border border-strong p-5">
          <h2 className="text-sm font-semibold text-primary mb-4">{t('costComparison.chartTitle', { dim: t(dim.labelKey) })}</h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={merged.slice(0, 12)} barCategoryGap="20%">
              <CartesianGrid {...chartGrid}  vertical={false} />
              <XAxis {...chartAxis} dataKey="name" tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} />
              <YAxis {...chartAxis} tickFormatter={v => fmtShort(v)} tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} />
              <Tooltip formatter={(v: number) => fmt(v)} />
              <Legend />
              <Bar isAnimationActive={false} maxBarSize={32} dataKey="period_a" name={t('costComparison.colPeriodA')} fill={chartColors.blue} radius={[4, 4, 0, 0]} />
              <Bar isAnimationActive={false} maxBarSize={32} dataKey="period_b" name={t('costComparison.colPeriodB')} fill={chartColors.orange} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Diff table */}
      <div className="bg-surface rounded-xl border border-strong overflow-hidden">
        <div className="px-5 py-4 border-b border-strong flex items-center justify-between">
          <h2 className="text-sm font-semibold text-primary">{t('costComparison.detailedComparison')}</h2>
          <span className="text-xs text-secondary">{t('costComparison.itemsCount', { count: merged.length })}</span>
        </div>
        <div className="overflow-x-auto">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact"><Table.Row className="border-b border-strong">
              {[t(dim.headerKey), t('costComparison.colPeriodA'), t('costComparison.colPeriodB'), t('costComparison.colDeltaAmount', { currency }), t('costComparison.colDeltaPct')].map(h => (
                <Table.Head key={h} className="px-4 py-3 text-left">{h}</Table.Head>
              ))}
            </Table.Row></Table.Header>
            <Table.Body className="divide-y divide-edge">
              {merged.length === 0 ? (
                <Table.Row><Table.Cell colSpan={5} className="px-4 py-10 text-center text-muted">{t('costComparison.noData')}</Table.Cell></Table.Row>
              ) : merged.map((r) => (
                <Table.Row key={r.key} className="hover:bg-subtle">
                  <Table.Cell className="px-4 py-3 font-medium text-primary">{r.full_name ?? r.name}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-accent">{fmt(r.period_a)}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-primary">{fmt(r.period_b)}</Table.Cell>
                  <Table.Cell className={`px-4 py-3 font-semibold ${r.delta > 0 ? 'text-danger' : r.delta < 0 ? 'text-success' : 'text-secondary'}`}>
                    {r.delta > 0 ? '+' : ''}{fmt(r.delta)}
                  </Table.Cell>
                  <Table.Cell className={`px-4 py-3 font-semibold ${r.delta_pct > 0 ? 'text-danger' : r.delta_pct < 0 ? 'text-success' : 'text-secondary'}`}>
                    {r.delta_pct > 0 ? '+' : ''}{r.delta_pct.toFixed(1)}%
                    {Math.abs(r.delta_pct) > 50 && (
                      <span className="ml-1 px-1 bg-danger/10 text-danger rounded text-xs">!</span>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      </div>
    </div>
  )
}
