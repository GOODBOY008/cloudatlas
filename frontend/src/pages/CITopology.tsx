import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface ForestNode {
  id: string
  name: string
  display_name?: string | null
  ci_type_id?: string | null
  ci_type_name?: string | null
  lifecycle_state: string
  cloud_region?: string | null
  depth: number
  children: ForestNode[]
}

interface CIType {
  id: string
  name: string
  display_name: string
}

interface CI {
  id: string
  name: string
  display_name?: string
}

const LIFECYCLE_COLORS: Record<string, string> = {
  active: 'bg-green-900/40 text-green-300',
  stopped: 'bg-yellow-900/40 text-yellow-300',
  terminated: 'bg-red-900/40 text-red-300',
  provisioning: 'bg-blue-900/40 text-blue-300',
  maintenance: 'bg-purple-900/40 text-purple-300',
}

function TreeNode({
  node,
  onSetParent,
  candidates,
  selectedId,
  onSelect,
  t,
}: {
  node: ForestNode
  onSetParent: (childId: string, parentId: string) => void
  candidates: CI[]
  selectedId: string | null
  onSelect: (id: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const [expanded, setExpanded] = useState(true)
  const [showParentPicker, setShowParentPicker] = useState(false)

  return (
    <div className="ml-0">
      <div
        className={`flex items-center gap-2 py-1 group rounded-lg px-2 transition-colors ${
          selectedId === node.id ? 'bg-indigo-600/20' : 'hover:bg-gray-800/50'
        }`}
      >
        {node.children.length > 0 ? (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-gray-500 hover:text-gray-300 text-xs w-4"
            aria-label={expanded ? 'collapse' : 'expand'}
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="w-4 text-gray-700 text-xs">•</span>
        )}
        <button onClick={() => onSelect(node.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <span className="text-sm text-white truncate">{node.display_name || node.name}</span>
          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${LIFECYCLE_COLORS[node.lifecycle_state] ?? 'bg-gray-700 text-gray-400'}`}>
            {t(`lifecycle.${node.lifecycle_state}`, { defaultValue: node.lifecycle_state })}
          </span>
          {node.cloud_region && <span className="text-xs text-gray-600">{node.cloud_region}</span>}
        </button>
        <button
          onClick={() => setShowParentPicker((v) => !v)}
          className="text-xs text-gray-500 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {t('ciTopology.setParent')}
        </button>
      </div>

      {showParentPicker && (
        <div className="flex items-center gap-2 py-1 pl-8">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                onSetParent(node.id, e.target.value)
                setShowParentPicker(false)
              }
            }}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
          >
            <option value="">{t('ciTopology.chooseParent')}</option>
            {candidates
              .filter((c) => c.id !== node.id)
              .map((c) => (
                <option key={c.id} value={c.id}>{c.display_name || c.name}</option>
              ))}
          </select>
          <button
            onClick={() => {
              onSetParent(node.id, '')
              setShowParentPicker(false)
            }}
            className="text-xs text-gray-500 hover:text-red-400"
          >
            {t('ciTopology.clearParent')}
          </button>
        </div>
      )}

      {expanded && node.children.length > 0 && (
        <div className="ml-4 border-l border-gray-800 pl-2">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              onSetParent={onSetParent}
              candidates={candidates}
              selectedId={selectedId}
              onSelect={onSelect}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function CITopology() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [typeFilter, setTypeFilter] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const { data: forest, isLoading } = useQuery<{ roots: ForestNode[]; total_nodes: number }>({
    queryKey: ['ci-forest', orgId, typeFilter],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { roots: ForestNode[]; total_nodes: number } }>(
        `/orgs/${orgId}/ci-forest`,
        { params: typeFilter ? { ci_type_id: typeFilter } : {} },
      )
      return res.data ?? { roots: [], total_nodes: 0 }
    },
  })

  // Candidate parents: same-type CIs (type-scoped when a filter is set).
  const { data: candidates = [] } = useQuery<CI[]>({
    queryKey: ['ci-topology-candidates', orgId, typeFilter],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CI[] }>(`/orgs/${orgId}/cis`, {
        params: { per_page: 200, ...(typeFilter ? { ci_type_id: typeFilter } : {}) },
      })
      return res.data ?? []
    },
  })

  const setParentMutation = useMutation({
    mutationFn: ({ childId, parentId }: { childId: string; parentId: string }) =>
      api.put(`/orgs/${orgId}/cis/${childId}`, parentId
        ? { parent_ci_id: parentId }
        : { remove_parent: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-forest', orgId, typeFilter] })
      setActionError('')
    },
    onError: (err: any) => setActionError(err?.response?.data?.error?.message ?? t('ciTopology.setParentFailed')),
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">{t('ciTopology.title')}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t('ciTopology.subtitle')}</p>
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm"
          data-testid="ci-topology-type-select"
        >
          <option value="">{t('ciTopology.allTypes')}</option>
          {ciTypes.map((ct) => (
            <option key={ct.id} value={ct.id}>{ct.display_name}</option>
          ))}
        </select>
      </div>

      {actionError && (
        <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">{actionError}</div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : !forest || forest.roots.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('ciTopology.empty')}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="ci-topology-tree">
          <p className="text-xs text-gray-500 mb-3">
            {t('ciTopology.nodeCount', { count: forest.total_nodes })}
          </p>
          {forest.roots.map((root) => (
            <TreeNode
              key={root.id}
              node={root}
              onSetParent={(childId, parentId) => setParentMutation.mutate({ childId, parentId })}
              candidates={candidates}
              selectedId={selectedNodeId}
              onSelect={setSelectedNodeId}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}
