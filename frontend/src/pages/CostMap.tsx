import { useState, useCallback, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useThemeStore } from '../store/themeStore'

// World atlas topojson (hosted by unpkg / jsdelivr — no build-time dependency needed)
const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'

const DATE_RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'MTD', days: null },
]

const PROVIDER_COLORS: Record<string, string> = {
  aws:     '#f59e0b',
  azure:   '#3b82f6',
  gcp:     '#10b981',
  unknown: '#6b7280',
}

const TREEMAP_COLORS = [
  '#299d87', '#7b87c2', '#c983a0', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
]

const VIEW_TABS = ['World Map', 'Treemap', 'Unit Economics', 'Budget Matrix']

function getDateRange(days: number | null): { startDate: string; endDate: string } {
  const end = new Date()
  const endDate = end.toISOString().slice(0, 10)
  if (days === null) {
    const startDate = new Date(end.getFullYear(), end.getMonth(), 1).toISOString().slice(0, 10)
    return { startDate, endDate }
  }
  const start = new Date(Date.now() - (days - 1) * 86_400_000)
  return { startDate: start.toISOString().slice(0, 10), endDate }
}

// Scale bubble radius based on sqrt of cost fraction — clamp to [6, 48]
function bubbleRadius(cost: number, maxCost: number): number {
  if (maxCost <= 0) return 6
  return Math.max(6, Math.min(48, Math.sqrt(cost / maxCost) * 48))
}

interface RegionExpense {
  region: string
  cloud_type: string
  total_cost: number
  resource_count: number
  pct: number
  coordinates: { lat: number; lon: number }
  label: string
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
}: {
  entry: RegionExpense | null
  position: { x: number; y: number }
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
        <span className="text-accent font-medium">${entry.total_cost.toLocaleString()}</span>
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
            background: `${PROVIDER_COLORS[entry.cloud_type] ?? '#6b7280'}20`,
            color: PROVIDER_COLORS[entry.cloud_type] ?? '#9ca3af',
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
}) {
  const { x = 0, y = 0, width = 0, height = 0, name = '', value = 0, depth = 0, index = 0, isDark = true } = props
  if (width < 30 || height < 20) return null
  const color = TREEMAP_COLORS[index % TREEMAP_COLORS.length]
  const cellStroke = isDark ? '#1f2937' : '#f3f4f6'
  const labelFill = '#fff'
  const subLabelFill = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.85)'
  return (
    <g>
      <rect
        x={x + 1} y={y + 1} width={width - 2} height={height - 2}
        rx={4}
        style={{ fill: color, opacity: depth === 1 ? 0.85 : 0.6, stroke: cellStroke, strokeWidth: 2 }}
      />
      {width > 60 && height > 30 && (
        <>
          <text x={x + 8} y={y + 18} fill={labelFill} fontSize={11} fontWeight={600} textAnchor="start">
            {name.length > 18 ? name.slice(0, 16) + '…' : name}
          </text>
          {height > 44 && (
            <text x={x + 8} y={y + 32} fill={subLabelFill} fontSize={10} textAnchor="start">
              ${(value as number).toLocaleString()}
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
  const mapTheme = isDark
    ? {
        mapBg:       '#0f1620',
        geoFill:     '#273547',
        geoStroke:   '#334155',
        geoHover:    '#334155',
        labelFill:   '#e2e8f0',
        tooltip:     { background: '#111827', border: '1px solid #374151', borderRadius: 8, color: '#f9fafb' } as React.CSSProperties,
        axisTickStyle: { fill: '#9ca3af', fontSize: 11 } as Record<string, unknown>,
      }
    : {
        mapBg:       '#f2f5f8',
        geoFill:     '#dce5ec',
        geoStroke:   '#b9c9d4',
        geoHover:    '#a8bfc9',
        labelFill:   '#0f172a',
        tooltip:     { background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, color: '#111827' } as React.CSSProperties,
        axisTickStyle: { fill: '#6b7280', fontSize: 11 } as Record<string, unknown>,
      }

  const [activeRange, setActiveRange] = useState(1)
  const [activeTab, setActiveTab] = useState('World Map')
  const [hoveredRegion, setHoveredRegion] = useState<RegionExpense | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [primaryDim, setPrimaryDim] = useState('service')
  const [secondaryDim, setSecondaryDim] = useState('')
  const [drillFilter, setDrillFilter] = useState<{ dim: string; val: string } | null>(null)
  const [mapZoom, setMapZoom] = useState(1.0)
  const [mapCenter, setMapCenter] = useState<[number, number]>([0, 20])

  const { startDate, endDate } = getDateRange(DATE_RANGES[activeRange].days)

  // ── Region Expenses (world map tab) ─────────────────────────────────────────

  const { data: regionData, isLoading: regionLoading } = useQuery<RegionExpensesResponse>({
    queryKey: ['region-expenses', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'World Map',
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/expenses/region-expenses`, {
        params: { start_date: startDate, end_date: endDate },
      })
      return res
    },
  })

  // ── Cost Map (treemap tab) ───────────────────────────────────────────────────

  const { data: costMapData, isLoading: costMapLoading } = useQuery<CostMapResponse>({
    queryKey: ['cost-map', orgId, startDate, endDate, primaryDim, secondaryDim, drillFilter],
    enabled: !!orgId && activeTab === 'Treemap',
    queryFn: async () => {
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
      const { data: res } = await api.get(`/orgs/${orgId}/expenses/cost-map`, { params })
      return res
    },
  })

  // ── Unit Economics ───────────────────────────────────────────────────────────

  const { data: unitEcon, isLoading: unitEconLoading } = useQuery<{ data: UnitEcon[]; total_cost: number }>({
    queryKey: ['unit-economics', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'Unit Economics',
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/expenses/unit-economics`, {
        params: { start_date: startDate, end_date: endDate },
      })
      return res
    },
  })

  // ── Budget Matrix ────────────────────────────────────────────────────────────

  const { data: budgetMatrix, isLoading: budgetLoading } = useQuery<{ data: BudgetRow[] }>({
    queryKey: ['cost-map-budget-matrix', orgId],
    enabled: !!orgId && activeTab === 'Budget Matrix',
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/pools/budget-matrix`)
      return res
    },
  })

  const handleMapMouseMove = useCallback((e: React.MouseEvent<SVGElement>) => {
    setTooltipPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
  }, [])

  const expenses = useMemo(() => regionData?.expenses ?? [], [regionData])
  const maxCost = Math.max(...expenses.map((e) => e.total_cost), 1)

  // ── Auto-fit: derive zoom + center from bounding box of loaded regions ───────
  const { autoZoom, autoCenter } = useMemo((): { autoZoom: number; autoCenter: [number, number] } => {
    if (expenses.length === 0) return { autoZoom: 1.0, autoCenter: [0, 20] }
    const lons = expenses.map((e) => e.coordinates.lon)
    const lats = expenses.map((e) => e.coordinates.lat)
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
  }, [expenses])

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
    name: n.label,
    value: n.cost,
    children: n.children?.map((c, j) => ({ name: c.label, value: c.cost, index: j })),
    index: i,
  }))

  return (
    <div className="flex flex-col text-primary">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('costMap.title')}</h1>
          <p className="text-xs text-muted mt-0.5">{t('costMap.subtitle')}</p>
        </div>

        {/* Date range */}
        <div className="flex gap-1 ml-auto">
          {DATE_RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setActiveRange(i)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                activeRange === i
                  ? 'bg-accent text-on-accent'
                  : 'bg-subtle text-secondary hover:bg-emphasis'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Total cost banner */}
      {regionData && activeTab === 'World Map' && (
        <div className="mt-1 px-5 py-4 bg-surface rounded-lg flex items-center gap-6 border border-edge">
          <div>
            <p className="text-xs text-muted">{t('costMap.totalSpend')}</p>
            <p className="text-2xl font-bold text-primary">${regionData.total_cost.toLocaleString()}</p>
          </div>
          <div className="h-8 w-px bg-emphasis" />
          <div>
            <p className="text-xs text-muted">{t('costMap.regions')}</p>
            <p className="text-lg font-semibold text-accent">{expenses.length}</p>
          </div>
          <div className="h-8 w-px bg-emphasis" />
          <div>
            <p className="text-xs text-muted">{t('costMap.period')}</p>
            <p className="text-sm text-secondary">{regionData.start_date} → {regionData.end_date}</p>
          </div>
        </div>
      )}

      {/* View tabs */}
      <div className="mt-5 flex gap-1 overflow-x-auto border-b border-edge pb-0">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-secondary'
            }`}
          >
            {viewTabLabels[tab]}
          </button>
        ))}
      </div>

      <div className="flex-1 py-5 space-y-6">

        {/* ── World Map ───────────────────────────────────────────────────── */}
        {activeTab === 'World Map' && (
          <div className="space-y-6">
            {regionLoading ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('common.loading')}</div>
            ) : (
              <>
                {/* Map */}
                <div className="bg-surface rounded-xl border border-edge p-2 relative">
                  <div className="flex items-center justify-between px-3 py-2">
                    <p className="text-xs font-semibold text-secondary uppercase tracking-wider">{t('costMap.cloudRegionSpend')}</p>
                    <div className="flex gap-2">
                      {Object.entries(PROVIDER_COLORS).filter(([k]) => k !== 'unknown').map(([k, c]) => (
                        <span key={k} className="flex items-center gap-1.5 text-xs text-secondary">
                          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: c }} />
                          {k.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </div>
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
                        <Geographies geography={GEO_URL}>
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

                        {expenses.map((entry) => {
                          const r = bubbleRadius(entry.total_cost, maxCost)
                          const color = PROVIDER_COLORS[entry.cloud_type] ?? '#6b7280'
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
                    <MapTooltip entry={hoveredRegion} position={tooltipPos} />

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
                </div>

                {/* Provider breakdown bar chart */}
                {byProvider.length > 0 && (
                  <div className="bg-surface rounded-xl border border-edge p-5">
                    <p className="text-sm font-semibold text-secondary mb-4">{t('costMap.spendByProvider')}</p>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart data={byProvider} layout="vertical" margin={{ left: 16, right: 24 }}>
                        <XAxis type="number" tick={mapTheme.axisTickStyle} tickFormatter={(v: number) => `$${v.toLocaleString()}`} />
                        <YAxis type="category" dataKey="name" tick={mapTheme.axisTickStyle} width={70} />
                        <Tooltip
                          contentStyle={mapTheme.tooltip}
                          formatter={(v: number) => [`$${v.toLocaleString()}`, t('costMap.cost')]}
                        />
                        <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                          {byProvider.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={PROVIDER_COLORS[entry.name.toLowerCase()] ?? '#299d87'}
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
                    <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                          <th className="px-5 py-3 text-left">{t('cmdb.region')}</th>
                          <th className="px-5 py-3 text-left">{t('costMap.location')}</th>
                          <th className="px-5 py-3 text-left">{t('costMap.cloud')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.resources')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.cost')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.share')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expenses.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-5 py-8 text-center text-muted text-sm">
                              {t('costMap.noExpenseData')}
                            </td>
                          </tr>
                        ) : (
                          expenses.map((e) => (
                            <tr key={`${e.region}-${e.cloud_type}`} className="border-b border-edge/50 hover:bg-subtle/30 transition-colors">
                              <td className="px-5 py-3 font-mono text-xs text-secondary">{e.region}</td>
                              <td className="px-5 py-3 text-secondary">{e.label}</td>
                              <td className="px-5 py-3">
                                <span
                                  className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                                  style={{
                                    background: `${PROVIDER_COLORS[e.cloud_type] ?? '#6b7280'}20`,
                                    color: PROVIDER_COLORS[e.cloud_type] ?? '#9ca3af',
                                  }}
                                >
                                  {e.cloud_type.toUpperCase()}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-right text-secondary">{e.resource_count}</td>
                              <td className="px-5 py-3 text-right font-semibold text-primary">
                                ${e.total_cost.toLocaleString()}
                              </td>
                              <td className="px-5 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 bg-subtle rounded-full h-1.5">
                                    <div
                                      className="h-1.5 rounded-full bg-accent"
                                      style={{ width: `${Math.min(100, e.pct)}%` }}
                                    />
                                  </div>
                                  <span className="text-secondary text-xs w-10 text-right">{e.pct}%</span>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table></div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Treemap ─────────────────────────────────────────────────────── */}
        {activeTab === 'Treemap' && (
          <div className="space-y-4">
            {/* Dimension controls */}
            <div className="bg-surface rounded-xl border border-edge p-4 flex flex-wrap gap-4 items-center">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted">{t('costMap.groupBy')}</label>
                <select
                  value={primaryDim}
                  onChange={(e) => { setPrimaryDim(e.target.value); setDrillFilter(null) }}
                  className="bg-subtle border border-strong rounded px-2 py-1 text-sm text-primary focus:outline-none focus:border-accent"
                >
                  {DIM_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{dimLabels[o.value]}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted">{t('costMap.thenBy')}</label>
                <select
                  value={secondaryDim}
                  onChange={(e) => setSecondaryDim(e.target.value)}
                  className="bg-subtle border border-strong rounded px-2 py-1 text-sm text-primary focus:outline-none focus:border-accent"
                >
                  <option value="">{t('costMap.none')}</option>
                  {DIM_OPTIONS.filter((o) => o.value !== primaryDim).map((o) => (
                    <option key={o.value} value={o.value}>{dimLabels[o.value]}</option>
                  ))}
                </select>
              </div>
              {/* Drill-down breadcrumb */}
              {drillFilter && (
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-xs text-muted">{t('costMap.filteredBy')}</span>
                  <span className="px-2 py-0.5 rounded bg-accent-soft/60 text-accent text-xs font-medium">
                    {dimLabels[drillFilter.dim] ?? drillFilter.dim}: {drillFilter.val}
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

            {costMapLoading ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('common.loading')}</div>
            ) : !costMapData || costMapData.nodes.length === 0 ? (
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
                      {t('costMap.total')}: <span className="text-primary font-semibold">${costMapData.total_cost.toLocaleString()}</span>
                    </p>
                  </div>
                  <ResponsiveContainer width="100%" height={400}>
                    <Treemap
                      data={treemapNodes}
                      dataKey="value"
                      content={<TreemapCell isDark={isDark} />}
                    />
                  </ResponsiveContainer>
                </div>

                {/* Top nodes table with drill-down */}
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-5 py-3 border-b border-edge">
                    <p className="text-xs text-muted">{t('costMap.clickToDrill')}</p>
                  </div>
                  <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                        <th className="px-5 py-3 text-left">{t('common.name')}</th>
                        <th className="px-5 py-3 text-right">{t('costMap.resources')}</th>
                        <th className="px-5 py-3 text-right">{t('costMap.cost')}</th>
                        <th className="px-5 py-3 text-right">{t('costMap.share')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costMapData.nodes.map((n) => (
                        <tr
                          key={n.key}
                          className="border-b border-edge/50 hover:bg-subtle/40 cursor-pointer transition-colors"
                          onClick={() => setDrillFilter({ dim: primaryDim, val: n.key })}
                        >
                          <td className="px-5 py-3 text-primary">{n.label}</td>
                          <td className="px-5 py-3 text-right text-secondary">{n.resource_count}</td>
                          <td className="px-5 py-3 text-right font-semibold text-primary">
                            ${n.cost.toLocaleString()}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 bg-subtle rounded-full h-1.5">
                                <div
                                  className="h-1.5 rounded-full bg-accent"
                                  style={{ width: `${Math.min(100, n.pct)}%` }}
                                />
                              </div>
                              <span className="text-secondary text-xs w-10 text-right">{n.pct}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Unit Economics ───────────────────────────────────────────────── */}
        {activeTab === 'Unit Economics' && (
          <div className="space-y-4">
            {unitEconLoading ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('common.loading')}</div>
            ) : !unitEcon || unitEcon.data.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('costMap.noData')}</div>
            ) : (
              <>
                {/* Bar chart */}
                <div className="bg-surface rounded-xl border border-edge p-5">
                  <p className="text-sm font-semibold text-secondary mb-4">{t('costMap.totalCostByType')}</p>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={unitEcon.data} margin={{ left: 8, right: 16 }}>
                      <XAxis dataKey="resource_type" tick={mapTheme.axisTickStyle} />
                      <YAxis tick={mapTheme.axisTickStyle} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip
                        contentStyle={mapTheme.tooltip}
                        formatter={(v: number) => [`$${v.toLocaleString()}`, t('resources.colTotalCost')]}
                      />
                      <Bar dataKey="total_cost" radius={[4, 4, 0, 0]}>
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
                    <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                          <th className="px-5 py-3 text-left">{t('costMap.resourceType')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.count')}</th>
                          <th className="px-5 py-3 text-right">{t('resources.colTotalCost')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.avgPerDay')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.avgPerResource')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.share')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unitEcon.data.map((row, i) => (
                          <tr key={row.resource_type} className="border-b border-edge/50 hover:bg-subtle/30">
                            <td className="px-5 py-3 flex items-center gap-2">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                                style={{ background: TREEMAP_COLORS[i % TREEMAP_COLORS.length] }}
                              />
                              <span className="text-primary">{row.resource_type}</span>
                            </td>
                            <td className="px-5 py-3 text-right text-secondary">{row.resource_count}</td>
                            <td className="px-5 py-3 text-right font-semibold text-primary">
                              ${row.total_cost.toLocaleString()}
                            </td>
                            <td className="px-5 py-3 text-right text-secondary">
                              ${row.avg_daily_cost.toLocaleString()}
                            </td>
                            <td className="px-5 py-3 text-right text-secondary">
                              ${row.avg_cost_per_resource.toLocaleString()}
                            </td>
                            <td className="px-5 py-3 text-right">
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
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Budget Matrix ────────────────────────────────────────────────── */}
        {activeTab === 'Budget Matrix' && (
          <div className="space-y-4">
            {budgetLoading ? (
              <div className="flex items-center justify-center h-64 text-muted text-sm">{t('common.loading')}</div>
            ) : !budgetMatrix || budgetMatrix.data.length === 0 ? (
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
                      <p className={`text-2xl font-bold ${s.cls}`}>{s.count}</p>
                    </div>
                  ))}
                </div>

                {/* Matrix table */}
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-5 py-3 border-b border-edge">
                    <p className="text-sm font-semibold text-secondary">{t('costMap.poolBudgetVsActual')}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-edge text-xs text-muted uppercase tracking-wider">
                          <th className="px-5 py-3 text-left">{t('costMap.pool')}</th>
                          <th className="px-5 py-3 text-left">{t('common.type')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.budget')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.actualMtd')}</th>
                          <th className="px-5 py-3 text-right">{t('costMap.variance')}</th>
                          <th className="px-5 py-3 text-center w-48">{t('costMap.utilisation')}</th>
                          <th className="px-5 py-3 text-center">{t('common.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {budgetMatrix.data.map((row) => (
                          <tr key={row.pool_id ?? row.pool_name} className="border-b border-edge/50 hover:bg-subtle/30">
                            <td className="px-5 py-3 font-medium text-primary">{row.pool_name}</td>
                            <td className="px-5 py-3 text-muted text-xs capitalize">{row.pool_type}</td>
                            <td className="px-5 py-3 text-right text-secondary">
                              {row.budget != null ? `$${row.budget.toLocaleString()}` : '—'}
                            </td>
                            <td className="px-5 py-3 text-right font-semibold text-primary">
                              ${row.actual.toLocaleString()}
                            </td>
                            <td className={`px-5 py-3 text-right text-sm font-medium ${
                              row.variance == null ? 'text-muted'
                              : row.variance >= 0 ? 'text-success'
                              : 'text-danger'
                            }`}>
                              {row.variance != null
                                ? `${row.variance >= 0 ? '+' : ''}$${row.variance.toLocaleString()}`
                                : '—'}
                            </td>
                            <td className="px-5 py-3">
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
                            </td>
                            <td className="px-5 py-3 text-center">
                              <StatusBadge status={row.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
