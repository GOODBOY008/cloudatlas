import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { SelectField } from '../components/shared/SelectField'
import { cloudServiceLabel } from '../lib/objectStorage'
import { chartColors, chartPalette, chartAxis, chartTooltipStyle, providerChartColors } from '../lib/chartTheme'
import { useState, useCallback, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Globe, Map as MapIcon } from 'lucide-react'
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  ZoomableGroup,
} from 'react-simple-maps'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Treemap,
} from 'recharts'
import { useTranslation } from 'react-i18next'
import worldGeographyUrl from 'world-atlas/countries-110m.json?url'
import api from '../lib/api'
import { billingDateRange } from '../lib/billingDates'
import { fmtMoney, useOrgCurrency } from '../lib/format'
import { ReportQueryState } from '../components/shared/ReportQueryState'
import { CostGlobe } from '../features/cost-map/CostGlobe'
import { hasMapLocation, type RegionExpense, type WorldGeography } from '../features/cost-map/regions'
import { useOrgStore } from '../store/orgStore'
import { useThemeStore } from '../store/themeStore'

const DATE_RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'MTD', days: null },
]

const PROVIDER_COLORS = providerChartColors

const TREEMAP_COLORS = chartPalette

const VIEW_TABS = ['World Map', 'Treemap', 'Unit Economics', 'Budget Matrix']

// Scale bubble radius based on sqrt of cost fraction — clamp to [6, 48]
function bubbleRadius(cost: number, maxCost: number): number {
  if (maxCost <= 0) return 6
  return Math.max(6, Math.min(48, Math.sqrt(Math.max(0, cost) / maxCost) * 48))
}

interface RegionExpensesResponse {
  expenses: RegionExpense[]
  total_cost: number
  start_date: string
  end_date: string
}

interface UnitEcon {
  resource_type: string
  resource_count: number
  total_cost: number
  avg_daily_cost: number
  avg_cost_per_resource: number
  pct_of_total: number
}

interface CostMapNode {
  key: string
  label: string
  cost: number
  pct: number
  resource_count: number
  children?: CostMapNode[]
}

interface CostMapResponse {
  total_cost: number
  nodes: CostMapNode[]
  dims: { primary: string; secondary: string | null }
}

interface BudgetRow {
  pool_id: string | null
  pool_name: string
  pool_type: string
  budget: number | null
  actual: number
  variance: number | null
  utilization_pct: number | null
  status: 'on_track' | 'warning' | 'over_budget' | 'no_budget'
}

const DIM_OPTIONS = [
  { value: 'service',       label: 'Service' },
  { value: 'region',        label: 'Region' },
  { value: 'resource_type', label: 'Resource Type' },
  { value: 'cloud',         label: 'Cloud Provider' },
  { value: 'pool',          label: 'Pool' },
]

// Theme-dependent configs are computed inside the component (see mapTheme below)

// ─── Tooltip Overlay ──────────────────────────────────────────────────────────

function MapTooltip({
  entry,
  position,
  currency,
}: {
  entry: RegionExpense | null
  position: { x: number; y: number }
  currency: string
}) {
  const { t } = useTranslation()
  if (!entry) return null
  return (
    <div
      className="pointer-events-none absolute z-50 bg-surface border border-strong rounded-lg px-3 py-2 text-xs shadow-lg min-w-[160px]"
      style={{ top: position.y + 12, left: position.x + 12 }}
    >
      <p className="font-semibold text-primary">{entry.label || entry.region}</p>
      <p className="text-secondary">{entry.region}</p>
      <p className="text-secondary mt-1">
        <span className="text-muted">{t('costMap.cost')}: </span>
        <span className="text-accent font-medium">{fmtMoney(entry.total_cost, currency)}</span>
      </p>
      <p className="text-secondary">
        <span className="text-muted">{t('costMap.resources')}: </span>
        {entry.resource_count}
      </p>
      <p className="text-secondary">
        <span className="text-muted">{t('costMap.share')}: </span>
        {entry.pct}%
      </p>
      <p className="mt-1">
        <span
          className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            background: `color-mix(in srgb, ${PROVIDER_COLORS[entry.cloud_type] ?? chartColors.muted} 12%, transparent)`,
            color: PROVIDER_COLORS[entry.cloud_type] ?? chartColors.muted,
          }}
        >
          {entry.cloud_type.toUpperCase()}
        </span>
      </p>
    </div>
  )
}

// ─── Budget Status Badge ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BudgetRow['status'] }) {
  const { t } = useTranslation()
  const map = {
    on_track:   { text: 'On Track',    cls: 'bg-success/10 text-success' },
    warning:    { text: 'Warning',     cls: 'bg-warning/10 text-warning' },
    over_budget:{ text: 'Over Budget', cls: 'bg-danger/10 text-danger' },
    no_budget:  { text: 'No Budget',   cls: 'bg-subtle text-muted' },
  }
  const s = map[status]
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {t(`status.${status}`, { defaultValue: s.text })}
    </span>
  )
}

// ─── Custom Treemap Content ───────────────────────────────────────────────────

function TreemapCell(props: {
  x?: number; y?: number; width?: number; height?: number
  name?: string; value?: number; depth?: number; index?: number
  isDark?: boolean
  currency: string
}) {
  const { x = 0, y = 0, width = 0, height = 0, name = '', value = 0, depth = 0, index = 0, isDark = true, currency } = props
  if (width < 30 || height < 20) return null
  const color = TREEMAP_COLORS[index % TREEMAP_COLORS.length]
  const cellStroke = 'rgb(var(--surface))'
  const labelFill = 'rgb(var(--text-primary))'
  const subLabelFill = 'rgb(var(--text-secondary))'
  return (
    <g>
      <rect
        x={x + 1} y={y + 1} width={width - 2} height={height - 2}
        rx={4}
        style={{ fill: color, fillOpacity: isDark ? 0.22 : depth === 1 ? 0.16 : 0.1, stroke: cellStroke, strokeWidth: 2 }}
      />
      {width > 60 && height > 30 && (
        <>
          <text x={x + 8} y={y + 18} fill={labelFill} fontSize={11} fontWeight={600} textAnchor="start">
            {name.length > 18 ? name.slice(0, 16) + '…' : name}
          </text>
          {height > 44 && (
            <text x={x + 8} y={y + 32} fill={subLabelFill} fontSize={10} textAnchor="start">
              {fmtMoney(value, currency)}
            </text>
          )}
        </>
      )}
    </g>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CostMap() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const currency = useOrgCurrency()
  const formatCost = (amount: number) => fmtMoney(amount, currency)
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'

  // Translated labels for dimension values (API values stay as state/query keys)
  const dimLabels: Record<string, string> = {
    service: t('costMap.dimService'),
    region: t('cmdb.region'),
    resource_type: t('costMap.resourceType'),
    cloud: t('costMap.dimCloud'),
    pool: t('costMap.dimPool'),
  }

  // Translated labels for the view tabs (VIEW_TABS values stay as state keys)
  const viewTabLabels: Record<string, string> = {
    'World Map': t('costMap.tabWorldMap'),
    'Treemap': t('costMap.tabTreemap'),
    'Unit Economics': t('costMap.tabUnitEconomics'),
    'Budget Matrix': t('costMap.tabBudgetMatrix'),
  }

  // Theme-dependent style tokens
  const mapTheme = {
    mapBg: 'rgb(var(--surface))',
    geoFill: 'rgb(var(--map-land))',
    geoStroke: 'rgb(var(--map-edge))',
    geoHover: 'rgb(var(--border-strong))',
    labelFill: 'rgb(var(--text-primary))',
    tooltip: chartTooltipStyle,
    axisTickStyle: chartAxis.tick,
  }

  const [activeRange, setActiveRange] = useState(1)
  const [activeTab, setActiveTab] = useState('World Map')
  const [projection, setProjection] = useState<'flat' | 'globe'>('flat')
  const [globeUnavailable, setGlobeUnavailable] = useState(false)
  const handleGlobeUnavailable = useCallback(() => {
    setProjection('flat')
    setGlobeUnavailable(true)
  }, [])
  const [hoveredRegion, setHoveredRegion] = useState<RegionExpense | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [primaryDim, setPrimaryDim] = useState('service')
  const [secondaryDim, setSecondaryDim] = useState('')
  const [drillFilter, setDrillFilter] = useState<{ dim: string; val: string } | null>(null)
  const [mapZoom, setMapZoom] = useState(1.0)
  const [mapCenter, setMapCenter] = useState<[number, number]>([0, 20])

  const { startDate, endDate } = billingDateRange(DATE_RANGES[activeRange].days)

  // ── Region Expenses (world map tab) ─────────────────────────────────────────

  const regionQuery = useQuery({
    queryKey: ['region-expenses', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'World Map',
    queryFn: async ({ signal }) => {
      const { data: res } = await api.get<RegionExpensesResponse>(`/orgs/${orgId}/expenses/region-expenses`, {
        params: { start_date: startDate, end_date: endDate },
        signal,
      })
      return res
    },
  })
  const regionData = regionQuery.data
  const geographyQuery = useQuery({
    queryKey: ['world-geography', worldGeographyUrl],
    enabled: !!orgId && activeTab === 'World Map',
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const response = await fetch(worldGeographyUrl, { signal })
      if (!response.ok) throw new Error('World geography could not be loaded')
      const geography: WorldGeography | null = await response.json()
      if (geography?.type !== 'Topology' || !Array.isArray(geography.arcs)
        || geography.objects?.countries?.type !== 'GeometryCollection' || !Array.isArray(geography.objects.countries.geometries)) {
        throw new Error('Invalid world geography')
      }
      return geography
    },
  })

  // ── Cost Map (treemap tab) ───────────────────────────────────────────────────

  const costMapQuery = useQuery({
    queryKey: ['cost-map', orgId, startDate, endDate, primaryDim, secondaryDim, drillFilter],
    enabled: !!orgId && activeTab === 'Treemap',
    queryFn: async ({ signal }) => {
      const params: Record<string, string> = {
        start_date: startDate,
        end_date: endDate,
        primary_dim: primaryDim,
      }
      if (secondaryDim) params.secondary_dim = secondaryDim
      if (drillFilter) {
        params.filter_dim = drillFilter.dim
        params.filter_val = drillFilter.val
      }
      const { data: res } = await api.get<CostMapResponse>(`/orgs/${orgId}/expenses/cost-map`, { params, signal })
      return res
    },
  })
  const costMapData = costMapQuery.data

  // ── Unit Economics ───────────────────────────────────────────────────────────

  const unitEconQuery = useQuery({
    queryKey: ['unit-economics', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'Unit Economics',
    queryFn: async ({ signal }) => {
      const { data: res } = await api.get<{ data: UnitEcon[]; total_cost: number }>(`/orgs/${orgId}/expenses/unit-economics`, {
        params: { start_date: startDate, end_date: endDate },
        signal,
      })
      return res
    },
  })
  const unitEcon = unitEconQuery.data

  // ── Budget Matrix ────────────────────────────────────────────────────────────

  const budgetQuery = useQuery({
    queryKey: ['cost-map-budget-matrix', orgId],
    enabled: !!orgId && activeTab === 'Budget Matrix',
    queryFn: async ({ signal }) => {
      const { data: res } = await api.get<{ data: BudgetRow[] }>(`/orgs/${orgId}/pools/budget-matrix`, { signal })
      return res
    },
  })
  const budgetMatrix = budgetQuery.data

  const handleMapMouseMove = useCallback((e: React.MouseEvent<SVGElement>) => {
    setTooltipPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
  }, [])

  const expenses = useMemo(() => regionData?.expenses ?? [], [regionData])
  const mappedRegions = useMemo(() => expenses.filter(hasMapLocation), [expenses])
  const maxCost = Math.max(...mappedRegions.map((e) => e.total_cost), 1)

  // ── Auto-fit: derive zoom + center from bounding box of loaded regions ───────
  const { autoZoom, autoCenter } = useMemo((): { autoZoom: number; autoCenter: [number, number] } => {
    if (mappedRegions.length === 0) return { autoZoom: 1.0, autoCenter: [0, 20] }
    const lons = mappedRegions.map((e) => e.coordinates.lon)
    const lats = mappedRegions.map((e) => e.coordinates.lat)
    const minLon = Math.min(...lons), maxLon = Math.max(...lons)
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    const centerLon = (minLon + maxLon) / 2
    const centerLat = (minLat + maxLat) / 2
    // Enforce a minimum span so a single point still gets a reasonable zoom
    const lonSpan = Math.max(maxLon - minLon, 20)
    const latSpan = Math.max(maxLat - minLat, 20)
    // 360° and 170° represent the full world in Mercator; multiply spans by 1.6 for padding
    const zFromLon = 360 / (lonSpan * 1.6)
    const zFromLat = 170 / (latSpan * 1.6)
    const zoom = Math.max(1.0, Math.min(6, Math.min(zFromLon, zFromLat)))
    return { autoZoom: zoom, autoCenter: [centerLon, centerLat] }
  }, [mappedRegions])

  // Sync map view whenever auto-fit values change (new data or date range)
  useEffect(() => {
    setMapZoom(autoZoom)
    setMapCenter(autoCenter)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoZoom, autoCenter[0], autoCenter[1]])

  // Group expenses by cloud provider for the provider bar chart
  const byProvider = Object.entries(
    expenses.reduce<Record<string, number>>((acc, e) => {
      acc[e.cloud_type] = (acc[e.cloud_type] ?? 0) + e.total_cost
      return acc
    }, {}),
  )
    .map(([name, cost]) => ({ name: name.toUpperCase(), cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost)

  const treemapNodes = (costMapData?.nodes ?? []).map((n, i) => ({
    name: primaryDim === 'service' ? cloudServiceLabel(n.label) : n.label,
    value: n.cost,
    children: n.children?.map((c, j) => ({ name: secondaryDim === 'service' ? cloudServiceLabel(c.label) : c.label, value: c.cost, index: j })),
    index: i,
  }))

  if (!orgId) return <div className="empty-state">{t('dashboard.selectWorkspace')}</div>

  return (
    <div className="flex flex-col text-primary">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('costMap.title')}</h1>
          <p className="text-xs text-muted mt-0.5">{t('costMap.subtitle')}</p>
        </div>

        {/* Date range */}
        <div className="segmented-control ml-auto">
          {DATE_RANGES.map((r, i) => (
            <button aria-pressed={activeRange === i}
              key={r.label}
              onClick={() => setActiveRange(i)}
              className="segment"
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Total cost banner */}
      {regionQuery.isSuccess && regionData && activeTab === 'World Map' && (
        <div className="map-summary">
          <div>
            <p className="text-xs text-muted">{t('costMap.totalSpend')}</p>
            <p className="text-2xl font-semibold text-primary">{formatCost(regionData.total_cost)}</p>
          </div>
          <div className="map-summary-divider" />
          <div>
            <p className="text-xs text-muted">{t('costMap.regions')}</p>
            <p className="text-lg font-semibold text-accent">{expenses.length}</p>
          </div>
          <div className="map-summary-divider" />
          <div>
            <p className="text-xs text-muted">{t('costMap.period')}</p>
            <p className="text-sm text-secondary">{regionData.start_date} → {regionData.end_date}</p>
          </div>
        </div>
      )}

      {/* View tabs */}
      <PageTabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mt-5"
        tabs={VIEW_TABS.map(tab => ({ value: tab, label: viewTabLabels[tab] }))}
      />

      <div className="flex-1 py-5 space-y-6">

        {/* ── World Map ───────────────────────────────────────────────────── */}
        {activeTab === 'World Map' && (
          <div className="space-y-6">
            <ReportQueryState query={regionQuery}>
              <>
                {/* Map */}
                <div className="bg-surface rounded-xl border border-edge p-2 relative">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                    <p className="text-sm font-semibold text-primary">{t('costMap.cloudRegionSpend')}</p>
                    <div role="group" aria-label={t('costMap.mapView')} className="segmented-control">
                      <button type="button" className="segment inline-flex items-center gap-1.5" aria-pressed={projection === 'flat'}
                        onClick={() => { setGlobeUnavailable(false); setProjection('flat') }}>
                        <MapIcon size={15} />{t('costMap.flatMap')}
                      </button>
                      <button type="button" className="segment inline-flex items-center gap-1.5" aria-pressed={projection === 'globe'}
                        onClick={() => { setHoveredRegion(null); setGlobeUnavailable(false); setProjection('globe') }}>
                        <Globe size={15} />{t('costMap.globe')}
                      </button>
                    </div>
                  </div>
                  <div className="px-3 pb-3">
                    <div className="flex flex-wrap gap-x-3 gap-y-2">
                      {Object.entries(PROVIDER_COLORS).filter(([k]) => k !== 'unknown').map(([k, c]) => (
                        <span key={k} className="flex items-center gap-1.5 text-xs text-secondary">
                          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: c }} />
                          {k.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </div>
                  {globeUnavailable && <p role="status" className="px-3 pb-2 text-xs text-secondary">{t('costMap.globeUnavailable')}</p>}
                  <ReportQueryState
                    query={geographyQuery}
                    errorMessage={t('costMap.geographyLoadFailed')}
                    loadingPlaceholder={<div className="skeleton h-[420px]" role="status" aria-label={t('common.loading')} />}
                  >
                    {geographyQuery.data && (projection === 'globe' ? (
                      <CostGlobe geography={geographyQuery.data} regions={mappedRegions} currency={currency} onUnavailable={handleGlobeUnavailable} />
                    ) : (
                      <div
                        className="relative overflow-hidden rounded-lg"
                        onMouseMove={handleMapMouseMove as unknown as React.MouseEventHandler<HTMLDivElement>}
                      >
                        <ComposableMap
                          projection="geoMercator"
                          projectionConfig={{ scale: 130, center: [0, 20] }}
                          style={{ width: '100%', height: '420px', background: mapTheme.mapBg, transition: 'background 0.2s' }}
                        >
                          <ZoomableGroup
                            zoom={mapZoom}
                            center={mapCenter}
                            onMoveEnd={({ zoom, coordinates }: { zoom: number; coordinates: [number, number] }) => {
                              setMapZoom(zoom)
                              setMapCenter(coordinates)
                            }}
                          >
                            <Geographies geography={geographyQuery.data}>
                              {({ geographies }: { geographies: object[] }) =>
                                geographies.map((geo: object) => (
                                  <Geography
                                    key={(geo as { rsmKey: string }).rsmKey}
                                    geography={geo}
                                    fill={mapTheme.geoFill}
                                    stroke={mapTheme.geoStroke}
                                    strokeWidth={0.5}
                                    style={{
                                      default: { outline: 'none' },
                                      hover: { fill: mapTheme.geoHover, outline: 'none' },
                                      pressed: { outline: 'none' },
                                    }}
                                  />
                                ))
                              }
                            </Geographies>

                            {mappedRegions.map((entry) => {
                              const r = bubbleRadius(entry.total_cost, maxCost)
                              const color = PROVIDER_COLORS[entry.cloud_type] ?? chartColors.muted
                              return (
                                <Marker
                                  key={`${entry.region}-${entry.cloud_type}`}
                                  coordinates={[entry.coordinates.lon, entry.coordinates.lat]}
                                  onMouseEnter={() => setHoveredRegion(entry)}
                                  onMouseLeave={() => setHoveredRegion(null)}
                                >
                                  <circle
                                    r={r / mapZoom}
                                    fill={color}
                                    fillOpacity={0.75}
                                    stroke={color}
                                    strokeWidth={1.5 / mapZoom}
                                    strokeOpacity={0.9}
                                    style={{ cursor: 'pointer' }}
                                  />
                                  {r > 18 && (
                                    <text
                                      textAnchor="middle"
                                      y={(r / mapZoom) + (10 / mapZoom)}
                                      style={{ fontFamily: 'sans-serif', fill: mapTheme.labelFill, fontSize: `${10 / mapZoom}px` }}
                                    >
                                      {entry.label || entry.region}
                                    </text>
                                  )}
                                </Marker>
                              )
                            })}
                          </ZoomableGroup>
                        </ComposableMap>

                        {/* Tooltip */}
                        <MapTooltip entry={hoveredRegion} position={tooltipPos} currency={currency} />

                        {/* Zoom controls */}
                        <div className="absolute bottom-3 right-3 flex flex-col gap-1">
                          {[{ label: '+', delta: 0.5 }, { label: '−', delta: -0.5 }].map(({ label, delta }) => (
                            <button
                              key={label}
                              onClick={() => setMapZoom((z) => Math.max(0.8, Math.min(8, z + delta)))}
                              className="w-7 h-7 bg-subtle hover:bg-emphasis border border-strong rounded text-secondary text-sm font-bold flex items-center justify-center"
                            >
                              {label}
                            </button>
                          ))}
                          <button
                            onClick={() => { setMapZoom(autoZoom); setMapCenter(autoCenter) }}
                            title={t('costMap.resetFit')}
                            className="w-7 h-7 bg-subtle hover:bg-emphasis border border-strong rounded text-muted text-[10px] flex items-center justify-center"
                          >
                            ⊕
                          </button>
                        </div>
                      </div>
                    ))}
                  </ReportQueryState>
                </div>

                {/* Provider breakdown bar chart */}
                {byProvider.length > 0 && (
                  <div className="bg-surface rounded-xl border border-edge p-5">
                    <p className="text-sm font-semibold text-secondary mb-4">{t('costMap.spendByProvider')}</p>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart data={byProvider} layout="vertical" margin={{ left: 16, right: 24 }}>
                        <XAxis {...chartAxis} type="number" tick={mapTheme.axisTickStyle} tickFormatter={formatCost} />
                        <YAxis {...chartAxis} type="category" dataKey="name" tick={mapTheme.axisTickStyle} width={70} />
                        <Tooltip
                          contentStyle={mapTheme.tooltip}
                          formatter={(v: number) => [formatCost(v), t('costMap.cost')]}
                        />
                        <Bar isAnimationActive={false} maxBarSize={32} dataKey="cost" radius={[0, 4, 4, 0]}>
                          {byProvider.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={PROVIDER_COLORS[entry.name.toLowerCase()] ?? chartColors.blue}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Region table */}
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-5 py-3 border-b border-edge">
                    <p className="text-sm font-semibold text-secondary">{t('costMap.regionBreakdown')}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                      <Table.Header variant="compact">
                        <Table.Row className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                          <Table.Head className="px-5 py-3 text-left">{t('cmdb.region')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-left">{t('costMap.location')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-left">{t('costMap.cloud')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.resources')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.cost')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.share')}</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {expenses.length === 0 ? (
                          <Table.Row>
                            <Table.Cell colSpan={6} className="px-5 py-8 text-center text-muted text-sm">
                              {t('costMap.noExpenseData')}
                            </Table.Cell>
                          </Table.Row>
                        ) : (
                          expenses.map((e) => (
                            <Table.Row key={`${e.region}-${e.cloud_type}`} className="border-b border-edge/50 hover:bg-subtle/30 transition-colors">
                              <Table.Cell className="px-5 py-3 font-mono text-xs text-secondary">{e.region}</Table.Cell>
                              <Table.Cell className="px-5 py-3 text-secondary">{e.label}</Table.Cell>
                              <Table.Cell className="px-5 py-3">
                                <span
                                  className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                                  style={{
                                    background: `color-mix(in srgb, ${PROVIDER_COLORS[e.cloud_type] ?? chartColors.muted} 12%, transparent)`,
                                    color: PROVIDER_COLORS[e.cloud_type] ?? chartColors.muted,
                                  }}
                                >
                                  {e.cloud_type.toUpperCase()}
                                </span>
                              </Table.Cell>
                              <Table.Cell className="px-5 py-3 text-right text-secondary">{e.resource_count}</Table.Cell>
                              <Table.Cell className="px-5 py-3 text-right font-semibold text-primary">
                                {formatCost(e.total_cost)}
                              </Table.Cell>
                              <Table.Cell className="px-5 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 bg-subtle rounded-full h-1.5">
                                    <div
                                      className="h-1.5 rounded-full bg-accent"
                                      style={{ width: `${Math.min(100, e.pct)}%` }}
                                    />
                                  </div>
                                  <span className="text-secondary text-xs w-10 text-right">{e.pct}%</span>
                                </div>
                              </Table.Cell>
                            </Table.Row>
                          ))
                        )}
                      </Table.Body>
                    </Table></div>
                  </div>
                </div>
              </>
            </ReportQueryState>
          </div>
        )}

        {/* ── Treemap ─────────────────────────────────────────────────────── */}
        {activeTab === 'Treemap' && (
          <div className="space-y-4">
            {/* Dimension controls */}
            <div className="bg-surface rounded-xl border border-edge p-4 flex flex-wrap gap-4 items-center">
              <div className="flex items-center gap-2">
                <SelectField
                  label={t('costMap.groupBy')}
                  value={primaryDim}
                  onValueChange={value => { setPrimaryDim(value); setDrillFilter(null) }}
                  items={DIM_OPTIONS.map((o) => ({ value: o.value, label: dimLabels[o.value] }))}
                />
              </div>
              <div className="flex items-center gap-2">
                <SelectField
                  label={t('costMap.thenBy')}
                  value={secondaryDim}
                  onValueChange={setSecondaryDim}
                  items={[
                    { value: "", label: t('costMap.none') },
                    ...DIM_OPTIONS.filter((o) => o.value !== primaryDim).map((o) => ({ value: o.value, label: dimLabels[o.value] })),
                  ]}
                />
              </div>
              {/* Drill-down breadcrumb */}
              {drillFilter && (
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-xs text-muted">{t('costMap.filteredBy')}</span>
                  <span className="px-2 py-0.5 rounded bg-accent-soft/60 text-accent text-xs font-medium">
                    {dimLabels[drillFilter.dim] ?? drillFilter.dim}: {drillFilter.dim === 'service' ? cloudServiceLabel(drillFilter.val) : drillFilter.val}
                  </span>
                  <button
                    onClick={() => setDrillFilter(null)}
                    className="text-muted hover:text-primary text-xs"
                  >
                    ✕ {t('costMap.clear')}
                  </button>
                </div>
              )}
            </div>

            <ReportQueryState query={costMapQuery}>{!costMapData || costMapData.nodes.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('costMap.noData')}</div>
            ) : (
              <>
                <div className="bg-surface rounded-xl border border-edge p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-secondary">
                      {t('costMap.costBreakdownBy', { dim: dimLabels[costMapData.dims.primary] ?? costMapData.dims.primary })}
                      {costMapData.dims.secondary ? t('costMap.drillArrow', { dim: dimLabels[costMapData.dims.secondary] ?? costMapData.dims.secondary }) : ''}
                    </p>
                    <p className="text-xs text-muted">
                      {t('costMap.total')}: <span className="text-primary font-semibold">{formatCost(costMapData.total_cost)}</span>
                    </p>
                  </div>
                  <ResponsiveContainer width="100%" height={400}>
                    <Treemap isAnimationActive={false}
                      data={treemapNodes}
                      dataKey="value"
                      content={<TreemapCell isDark={isDark} currency={currency} />}
                    />
                  </ResponsiveContainer>
                </div>

                {/* Top nodes table with drill-down */}
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-5 py-3 border-b border-edge">
                    <p className="text-xs text-muted">{t('costMap.clickToDrill')}</p>
                  </div>
                  <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                    <Table.Header variant="compact">
                      <Table.Row className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                        <Table.Head className="px-5 py-3 text-left">{t('common.name')}</Table.Head>
                        <Table.Head className="px-5 py-3 text-right">{t('costMap.resources')}</Table.Head>
                        <Table.Head className="px-5 py-3 text-right">{t('costMap.cost')}</Table.Head>
                        <Table.Head className="px-5 py-3 text-right">{t('costMap.share')}</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {costMapData.nodes.map((n) => (
                        <Table.Row
                          key={n.key}
                          className="border-b border-edge/50 hover:bg-subtle/40 cursor-pointer transition-colors"
                          onClick={() => setDrillFilter({ dim: primaryDim, val: n.key })}
                        >
                          <Table.Cell className="px-5 py-3 text-primary">{primaryDim === 'service' ? cloudServiceLabel(n.label) : n.label}</Table.Cell>
                          <Table.Cell className="px-5 py-3 text-right text-secondary">{n.resource_count}</Table.Cell>
                          <Table.Cell className="px-5 py-3 text-right font-semibold text-primary">
                            {formatCost(n.cost)}
                          </Table.Cell>
                          <Table.Cell className="px-5 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 bg-subtle rounded-full h-1.5">
                                <div
                                  className="h-1.5 rounded-full bg-accent"
                                  style={{ width: `${Math.min(100, n.pct)}%` }}
                                />
                              </div>
                              <span className="text-secondary text-xs w-10 text-right">{n.pct}%</span>
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table></div>
                </div>
              </>
            )}</ReportQueryState>
          </div>
        )}

        {/* ── Unit Economics ───────────────────────────────────────────────── */}
        {activeTab === 'Unit Economics' && (
          <div className="space-y-4">
            <ReportQueryState query={unitEconQuery}>{!unitEcon || unitEcon.data.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('costMap.noData')}</div>
            ) : (
              <>
                {/* Bar chart */}
                <div className="bg-surface rounded-xl border border-edge p-5">
                  <p className="text-sm font-semibold text-secondary mb-4">{t('costMap.totalCostByType')}</p>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={unitEcon.data} margin={{ left: 8, right: 16 }}>
                      <XAxis {...chartAxis} dataKey="resource_type" tick={mapTheme.axisTickStyle} />
                      <YAxis {...chartAxis} width={92} tick={mapTheme.axisTickStyle} tickFormatter={formatCost} />
                      <Tooltip
                        contentStyle={mapTheme.tooltip}
                        formatter={(v: number) => [formatCost(v), t('resources.colTotalCost')]}
                      />
                      <Bar isAnimationActive={false} maxBarSize={32} dataKey="total_cost" radius={[4, 4, 0, 0]}>
                        {unitEcon.data.map((_, i) => (
                          <Cell key={i} fill={TREEMAP_COLORS[i % TREEMAP_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Unit economics table */}
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-5 py-3 border-b border-edge">
                    <p className="text-sm font-semibold text-secondary">{t('costMap.perResourceTypeEconomics')}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                      <Table.Header variant="compact">
                        <Table.Row className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                          <Table.Head className="px-5 py-3 text-left">{t('costMap.resourceType')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.count')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('resources.colTotalCost')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.avgPerDay')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.avgPerResource')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.share')}</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {unitEcon.data.map((row, i) => (
                          <Table.Row key={row.resource_type} className="border-b border-edge/50 hover:bg-subtle/30">
                            <Table.Cell className="px-5 py-3 flex items-center gap-2">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                                style={{ background: TREEMAP_COLORS[i % TREEMAP_COLORS.length] }}
                              />
                              <span className="text-primary">{row.resource_type}</span>
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right text-secondary">{row.resource_count}</Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right font-semibold text-primary">
                              {formatCost(row.total_cost)}
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right text-secondary">
                              {formatCost(row.avg_daily_cost)}
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right text-secondary">
                              {formatCost(row.avg_cost_per_resource)}
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-16 bg-subtle rounded-full h-1.5">
                                  <div
                                    className="h-1.5 rounded-full"
                                    style={{
                                      width: `${Math.min(100, row.pct_of_total)}%`,
                                      background: TREEMAP_COLORS[i % TREEMAP_COLORS.length],
                                    }}
                                  />
                                </div>
                                <span className="text-secondary text-xs w-10 text-right">{row.pct_of_total}%</span>
                              </div>
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table></div>
                  </div>
                </div>
              </>
            )}</ReportQueryState>
          </div>
        )}

        {/* ── Budget Matrix ────────────────────────────────────────────────── */}
        {activeTab === 'Budget Matrix' && (
          <div className="space-y-4">
            <ReportQueryState query={budgetQuery}>{!budgetMatrix || budgetMatrix.data.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('costMap.noPools')}</div>
            ) : (
              <>
                {/* Summary cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    {
                      label: t('status.over_budget'),
                      count: budgetMatrix.data.filter((r) => r.status === 'over_budget').length,
                      cls: 'text-danger',
                    },
                    {
                      label: t('costMap.warning80'),
                      count: budgetMatrix.data.filter((r) => r.status === 'warning').length,
                      cls: 'text-warning',
                    },
                    {
                      label: t('status.on_track'),
                      count: budgetMatrix.data.filter((r) => r.status === 'on_track').length,
                      cls: 'text-success',
                    },
                    {
                      label: t('status.no_budget'),
                      count: budgetMatrix.data.filter((r) => r.status === 'no_budget').length,
                      cls: 'text-muted',
                    },
                  ].map((s) => (
                    <div key={s.label} className="bg-surface border border-edge rounded-xl p-4">
                      <p className="text-xs text-muted">{s.label}</p>
                      <p className={`text-2xl font-semibold ${s.cls}`}>{s.count}</p>
                    </div>
                  ))}
                </div>

                {/* Matrix table */}
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-5 py-3 border-b border-edge">
                    <p className="text-sm font-semibold text-secondary">{t('costMap.poolBudgetVsActual')}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                      <Table.Header variant="compact">
                        <Table.Row className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                          <Table.Head className="px-5 py-3 text-left">{t('costMap.pool')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-left">{t('common.type')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.budget')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.actualMtd')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-right">{t('costMap.variance')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-center w-48">{t('costMap.utilisation')}</Table.Head>
                          <Table.Head className="px-5 py-3 text-center">{t('common.status')}</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {budgetMatrix.data.map((row) => (
                          <Table.Row key={row.pool_id ?? row.pool_name} className="border-b border-edge/50 hover:bg-subtle/30">
                            <Table.Cell className="px-5 py-3 font-medium text-primary">{row.pool_name}</Table.Cell>
                            <Table.Cell className="px-5 py-3 text-muted text-xs capitalize">{row.pool_type}</Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right text-secondary">
                              {row.budget != null ? formatCost(row.budget) : '—'}
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3 text-right font-semibold text-primary">
                              {formatCost(row.actual)}
                            </Table.Cell>
                            <Table.Cell className={`px-5 py-3 text-right text-sm font-medium ${
                              row.variance == null ? 'text-muted'
                              : row.variance >= 0 ? 'text-success'
                              : 'text-danger'
                            }`}>
                              {row.variance != null
                                ? `${row.variance >= 0 ? '+' : ''}${formatCost(row.variance)}`
                                : '—'}
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3">
                              {row.utilization_pct != null ? (
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-subtle rounded-full h-2">
                                    <div
                                      className={`h-2 rounded-full transition-all ${
                                        row.status === 'over_budget' ? 'bg-danger-solid'
                                        : row.status === 'warning' ? 'bg-warning-solid'
                                        : 'bg-success-solid'
                                      }`}
                                      style={{ width: `${Math.min(100, row.utilization_pct)}%` }}
                                    />
                                  </div>
                                  <span className="text-xs text-secondary w-10 text-right flex-shrink-0">
                                    {row.utilization_pct}%
                                  </span>
                                </div>
                              ) : (
                                <span className="text-secondary text-xs">—</span>
                              )}
                            </Table.Cell>
                            <Table.Cell className="px-5 py-3 text-center">
                              <StatusBadge status={row.status} />
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table></div>
                  </div>
                </div>
              </>
            )}</ReportQueryState>
          </div>
        )}
      </div>
    </div>
  )
}
