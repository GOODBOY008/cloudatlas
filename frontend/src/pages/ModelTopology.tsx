import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface TopoNode {
  id: string
  name: string
  display_name: string
  ci_count: number
  classification_name?: string
  classification_display?: string
  icon?: string
  color?: string
}

interface TopoEdge {
  id: string
  src_ci_type_id: string
  dst_ci_type_id: string
  kind_display: string
  cardinality: string
  is_directional: boolean
  instance_count: number
}

interface Topology {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  hardware: '#6366f1',
  network: '#22c55e',
  software: '#f59e0b',
  cloud: '#06b6d4',
  security: '#ef4444',
  storage: '#8b5cf6',
  default: '#64748b',
}

function getColor(name?: string) {
  if (!name) return CLASSIFICATION_COLORS.default
  return CLASSIFICATION_COLORS[name.toLowerCase()] ?? CLASSIFICATION_COLORS.default
}

// Simple circular layout
function computeLayout(nodes: TopoNode[], width: number, height: number) {
  const cx = width / 2
  const cy = height / 2
  const r = Math.min(width, height) * 0.38
  return nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2
    return {
      ...n,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    }
  })
}

const SVG_W = 800
const SVG_H = 600
const NODE_R = 36

export default function ModelTopology() {
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<TopoNode | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const { data, isLoading, isError } = useQuery<Topology>({
    queryKey: ['model-topology', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Topology }>(
        `/orgs/${orgId}/cmdb/model-topology`
      )
      return res.data
    },
  })

  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []

  const laid = computeLayout(nodes, SVG_W, SVG_H)
  const nodeMap = Object.fromEntries(laid.map(n => [n.id, n]))

  // Build edge paths using quadratic curves to avoid straight overlap
  function edgePath(src: { x: number; y: number }, dst: { x: number; y: number }, i: number, total: number) {
    const dx = dst.x - src.x
    const dy = dst.y - src.y
    const mx = (src.x + dst.x) / 2
    const my = (src.y + dst.y) / 2
    const curve = total > 1 ? (i - (total - 1) / 2) * 30 : 0
    const nx = -dy / Math.sqrt(dx * dx + dy * dy) * curve
    const ny = dx / Math.sqrt(dx * dx + dy * dy) * curve
    return `M${src.x},${src.y} Q${mx + nx},${my + ny} ${dst.x},${dst.y}`
  }

  // Group edges by src+dst pair for curve offset
  const pairEdges: Record<string, TopoEdge[]> = {}
  edges.forEach(e => {
    const key = [e.src_ci_type_id, e.dst_ci_type_id].sort().join('|')
    pairEdges[key] = [...(pairEdges[key] ?? []), e]
  })

  const selectedEdges = selected
    ? edges.filter(e => e.src_ci_type_id === selected.id || e.dst_ci_type_id === selected.id)
    : []

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-white">{t('modelTopology.title')}</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {t('modelTopology.subtitle')}
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500 text-sm">{t('modelTopology.loading')}</p>
        </div>
      )}
      {isError && (
        <div className="flex items-center justify-center h-64">
          <p className="text-red-400 text-sm">{t('modelTopology.loadFailed')}</p>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="flex gap-4">
          {/* SVG Canvas */}
          <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden relative">
            {nodes.length === 0 ? (
              <div className="flex items-center justify-center h-96 text-gray-600">
                <div className="text-center">
                  <p className="text-4xl mb-3">🗺</p>
                  <p className="text-sm">{t('modelTopology.noCiTypes')}</p>
                </div>
              </div>
            ) : (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                width="100%"
                style={{ minHeight: 480 }}
              >
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563" />
                  </marker>
                  <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#818cf8" />
                  </marker>
                </defs>

                {/* Edges */}
                {edges.map((e, _idx) => {
                  const src = nodeMap[e.src_ci_type_id]
                  const dst = nodeMap[e.dst_ci_type_id]
                  if (!src || !dst) return null
                  const key = [e.src_ci_type_id, e.dst_ci_type_id].sort().join('|')
                  const group = pairEdges[key]
                  const pos = group.indexOf(e)
                  const isHot = selected
                    ? (e.src_ci_type_id === selected.id || e.dst_ci_type_id === selected.id)
                    : hovered === e.src_ci_type_id || hovered === e.dst_ci_type_id
                  const path = edgePath(src, dst, pos, group.length)

                  return (
                    <g key={e.id}>
                      <path
                        d={path}
                        fill="none"
                        stroke={isHot ? '#818cf8' : '#374151'}
                        strokeWidth={isHot ? 2 : 1.2}
                        markerEnd={e.is_directional ? (isHot ? 'url(#arrow-hot)' : 'url(#arrow)') : undefined}
                        strokeDasharray={isHot ? undefined : '4 3'}
                        opacity={selected && !isHot ? 0.2 : 1}
                      />
                      {/* Edge label */}
                      {isHot && (() => {
                        const mx = (src.x + dst.x) / 2
                        const my = (src.y + dst.y) / 2
                        return (
                          <text x={mx} y={my} textAnchor="middle" fill="#a5b4fc"
                            fontSize={10} dy={-6}>
                            {e.kind_display}
                          </text>
                        )
                      })()}
                    </g>
                  )
                })}

                {/* Nodes */}
                {laid.map(n => {
                  const color = getColor(n.classification_name)
                  const isSelected = selected?.id === n.id
                  const isHot = isSelected || hovered === n.id
                  const dim = selected && !isSelected && !selectedEdges.some(
                    e => e.src_ci_type_id === n.id || e.dst_ci_type_id === n.id
                  )

                  return (
                    <g
                      key={n.id}
                      transform={`translate(${n.x},${n.y})`}
                      className="cursor-pointer"
                      onMouseEnter={() => setHovered(n.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => setSelected(s => s?.id === n.id ? null : n)}
                      opacity={dim ? 0.25 : 1}
                    >
                      <circle
                        r={NODE_R + (isHot ? 4 : 0)}
                        fill={color}
                        fillOpacity={isSelected ? 0.9 : 0.55}
                        stroke={isSelected ? '#fff' : color}
                        strokeWidth={isSelected ? 2 : 1}
                        style={{ transition: 'all 0.15s' }}
                      />
                      <text textAnchor="middle" fill="white" fontSize={11} fontWeight={600} dy={-4}>
                        {n.icon ?? '📦'}
                      </text>
                      <text textAnchor="middle" fill="white" fontSize={10} dy={10} fontWeight={500}>
                        {n.display_name.length > 12
                          ? n.display_name.slice(0, 11) + '…'
                          : n.display_name}
                      </text>
                      <text textAnchor="middle" fill="#d1d5db" fontSize={9} dy={22}>
                        {t('modelTopology.ciCount', { count: n.ci_count })}
                      </text>
                    </g>
                  )
                })}
              </svg>
            )}
          </div>

          {/* Side Panel */}
          {selected && (
            <div className="w-64 bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4 self-start">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">{selected.display_name}</h2>
                <button onClick={() => setSelected(null)} className="text-gray-600 hover:text-gray-400 text-xs">✕</button>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-gray-500">{t('common.name')}</p>
                <p className="text-xs text-white font-mono">{selected.name}</p>
              </div>
              {selected.classification_display && (
                <div className="space-y-1">
                  <p className="text-xs text-gray-500">{t('modelTopology.classification')}</p>
                  <p className="text-xs text-white">{selected.classification_display}</p>
                </div>
              )}
              <div className="space-y-1">
                <p className="text-xs text-gray-500">{t('modelTopology.ciCountLabel')}</p>
                <p className="text-2xl font-bold text-indigo-400">{selected.ci_count}</p>
              </div>
              {selectedEdges.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">{t('modelTopology.connections', { count: selectedEdges.length })}</p>
                  <div className="space-y-2">
                    {selectedEdges.map(e => {
                      const other = e.src_ci_type_id === selected.id
                        ? nodeMap[e.dst_ci_type_id]
                        : nodeMap[e.src_ci_type_id]
                      const arrow = e.src_ci_type_id === selected.id ? '→' : '←'
                      return (
                        <div key={e.id} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400">{arrow}</span>
                          <span className="text-white truncate">{other?.display_name}</span>
                          <span className="text-gray-600 ml-auto shrink-0">{e.kind_display}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      {!isLoading && nodes.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(CLASSIFICATION_COLORS)
            .filter(([k]) => k !== 'default')
            .map(([cls, color]) => (
              <div key={cls} className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="w-3 h-3 rounded-full inline-block" style={{ background: color }} />
                {t(`modelTopology.classification.${cls}`, { defaultValue: cls.charAt(0).toUpperCase() + cls.slice(1) })}
              </div>
            ))
          }
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-3 h-3 rounded-full inline-block bg-gray-500" />
            {t('modelTopology.other')}
          </div>
        </div>
      )}
    </div>
  )
}
