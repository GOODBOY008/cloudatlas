import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useTranslation } from 'react-i18next'
import { useOrgStore } from '../store/orgStore'
import { ProviderBadge } from '../components/shared/ProviderBadge'
import { CLOUD_PROVIDERS, providerLabel } from '../lib/providers'
import type { CI } from '../types'

const LIFECYCLE_COLORS: Record<string, string> = {
  active: 'bg-green-900/40 text-green-300',
  stopped: 'bg-yellow-900/40 text-yellow-300',
  terminated: 'bg-red-900/40 text-red-300',
  unknown: 'bg-gray-700 text-gray-400',
}

const LIFECYCLE_STATES = ['active', 'stopped', 'terminated', 'unknown']

// Mirror of the backend lifecycle transition matrix (cmdb/validation.rs).
// Terminal states (retired/terminated) have no successors.
const LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  provisioning: ['active', 'maintenance', 'decommissioned', 'failed'],
  active: ['maintenance', 'stopped', 'decommissioned', 'failed'],
  maintenance: ['active', 'stopped', 'decommissioned'],
  stopped: ['active', 'maintenance', 'decommissioned'],
  decommissioning: ['decommissioned', 'active'],
  decommissioned: ['retired', 'terminated'],
  failed: ['active', 'maintenance', 'decommissioned'],
  retired: [],
  terminated: [],
}

function legalSuccessors(state: string): string[] {
  return LIFECYCLE_TRANSITIONS[state] ?? []
}

interface NewCIForm {
  name: string
  display_name: string
  cloud_provider: string
  cloud_region: string
  ci_type_id: string
  /** Dynamic attribute values for the selected CI type (key = attribute name). */
  meta: Record<string, string>
}

interface CIType {
  id: string
  name: string
  display_name: string
}

interface CiChangeEvent {
  id: number
  event_type: string
  ci_id: string
  ci_name: string | null
  created_at: number
}

interface CITypeAttribute {
  id: string
  name: string
  display_name: string
  attr_type: string
  is_required: boolean
}

interface ImpactedCI {
  id: string
  name: string
  ci_type?: string
  direction: 'incoming' | 'outgoing' | string
  kind?: string
}

interface ObjAssoc {
  id: string
  src_ci_type_id: string
  src_type_name: string
  kind_name: string
  dst_ci_type_id: string
  dst_type_name: string
}

interface CIHistoryEntry {
  id: string
  action: string
  update_fields?: string[]
  pre_data?: Record<string, unknown>
  cur_data?: Record<string, unknown>
  created_at: number | string
  operate_from?: string
}

// Raw audit payload from GET /cis/:id/history (backend field names differ
// from the drawer's display model: operation/field_changes/source).
interface AuditEntry {
  id: string
  operation: string
  field_changes?: { update_fields?: string[]; pre_data?: Record<string, unknown>; cur_data?: Record<string, unknown> } | null
  source?: string
  created_at: string
}

export function formatRelativeTime(unixSeconds: number | string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  // API returns ISO-8601 strings; accept both epochs and ISO timestamps.
  const ts = typeof unixSeconds === 'string' ? Date.parse(unixSeconds) / 1000 : unixSeconds
  if (!Number.isFinite(ts)) return '—'
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return t('cmdb.justNow')
  if (diff < 3600) return t('cmdb.minAgo', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('cmdb.hourAgo', { count: Math.floor(diff / 3600) })
  return t('cmdb.dayAgo', { count: Math.floor(diff / 86400) })
}

function CIDrawer({ ci, onClose }: { ci: CI; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showAddAssoc, setShowAddAssoc] = useState(false)
  const [assocKindId, setAssocKindId] = useState('')
  const [assocDstId, setAssocDstId] = useState('')
  const [assocError, setAssocError] = useState('')
  const [editingTags, setEditingTags] = useState(false)
  const [tagDraft, setTagDraft] = useState<Array<{ key: string; value: string }>>([])
  const [tagError, setTagError] = useState('')
  // Local copy of tags so the drawer reflects saves without waiting for the
  // parent list query to re-fetch and re-pass the prop.
  const [currentTags, setCurrentTags] = useState<Record<string, string>>(ci.tags ?? {})

  const { data: impactData } = useQuery<{ impacted_cis?: ImpactedCI[] }>({
    queryKey: ['ci-impact', orgId, ci.id],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { impacted_cis?: ImpactedCI[] } }>(`/orgs/${orgId}/cis/${ci.id}/impact`)
      return res.data ?? {}
    },
    retry: false,
  })

  const { data: history = [] } = useQuery<CIHistoryEntry[]>({
    queryKey: ['ci-history', orgId, ci.id],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AuditEntry[] }>(`/orgs/${orgId}/cis/${ci.id}/history?limit=5`)
      return (res.data ?? []).map((e) => ({
        id: e.id,
        action: e.operation,
        update_fields: e.field_changes?.update_fields ?? [],
        pre_data: e.field_changes?.pre_data,
        cur_data: e.field_changes?.cur_data,
        created_at: e.created_at,
        operate_from: e.source,
      }))
    },
    retry: false,
  })

  const associations = impactData?.impacted_cis ?? []
  const metaEntries = Object.entries(ci.meta ?? {})
  const tagEntries = Object.entries(currentTags ?? {})

  // Association creation: object association templates for this CI type
  const { data: objAssocData } = useQuery<{ data: ObjAssoc[] }>({
    queryKey: ['ci-object-associations', orgId],
    enabled: !!orgId && showAddAssoc,
    queryFn: async () => api.get(`/orgs/${orgId}/ci-object-associations`).then(r => r.data),
  })
  const objAssocs = (objAssocData?.data ?? []).filter(a => a.src_ci_type_id === ci.ci_type_id)

  // Available destination CIs
  const { data: allCIs } = useQuery<{ data: CI[] }>({
    queryKey: ['cmdb', orgId],
    enabled: !!orgId && showAddAssoc,
    // reuses cached data if already fetched
    queryFn: async () => api.get(`/orgs/${orgId}/cis`).then(r => r.data),
  })
  const dstCIs = (allCIs?.data ?? []).filter(c => c.id !== ci.id)

  const linkMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/cis/${ci.id}/associations`, {
        object_association_id: assocKindId,
        dst_ci_id: assocDstId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-impact', orgId, ci.id] })
      setShowAddAssoc(false)
      setAssocKindId('')
      setAssocDstId('')
      setAssocError('')
    },
    onError: () => setAssocError(t('cmdb.assocFailed')),
  })

  // T11: parent CI management (same-type candidates).
  const [editingParent, setEditingParent] = useState(false)
  const [parentDraft, setParentDraft] = useState('')

  const { data: parentCandidates } = useQuery<{ data: CI[] }>({
    queryKey: ['cmdb-parent-candidates', orgId, ci.ci_type_id],
    enabled: !!orgId && editingParent,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CI[] }>(`/orgs/${orgId}/cis`, {
        params: { ci_type_id: ci.ci_type_id, per_page: 200 },
      })
      return res
    },
  })
  const candidates = (parentCandidates?.data ?? []).filter((c) => c.id !== ci.id)

  const setParentMutation = useMutation({
    mutationFn: (parentId: string) =>
      parentId
        ? api.put(`/orgs/${orgId}/cis/${ci.id}`, { parent_ci_id: parentId })
        : api.put(`/orgs/${orgId}/cis/${ci.id}`, { remove_parent: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
      setEditingParent(false)
      setParentDraft('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/orgs/${orgId}/cis/${ci.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
      onClose()
    },
    onError: () => setAssocError(t('cmdb.deleteFailed')),
  })

  function handleDelete() {
    if (window.confirm(t('cmdb.deleteConfirm', { name: ci.display_name || ci.name }))) {
      deleteMutation.mutate()
    }
  }

  const patchTags = useMutation({
    mutationFn: (tags: Record<string, string>) =>
      api.patch(`/orgs/${orgId}/cis/${ci.id}/tags`, { tags }),
    onSuccess: (res) => {
      // Update local view immediately so the drawer reflects the new tags
      // before the list query re-fetches.
      const next = (res?.data?.data?.tags ?? {}) as Record<string, string>
      setCurrentTags(next)
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
      queryClient.invalidateQueries({ queryKey: ['ci-history', orgId, ci.id] })
      setEditingTags(false)
      setTagError('')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error?.message ?? t('cmdb.tagsSaveFailed')
      setTagError(msg)
    },
  })

  function startTagEdit() {
    // Initialize the draft with one row per existing tag, plus one empty row.
    const rows = Object.entries(currentTags).map(([key, value]) => ({ key, value }))
    if (rows.length === 0) rows.push({ key: '', value: '' })
    setTagDraft(rows)
    setTagError('')
    setEditingTags(true)
  }

  function updateTagRow(idx: number, field: 'key' | 'value', value: string) {
    setTagDraft((prev) => prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row)))
  }

  function addTagRow() {
    setTagDraft((prev) => [...prev, { key: '', value: '' }])
  }

  function removeTagRow(idx: number) {
    setTagDraft((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleSaveTags() {
    const cleaned: Record<string, string> = {}
    const seen = new Set<string>()
    for (let i = 0; i < tagDraft.length; i++) {
      const { key, value } = tagDraft[i]
      const k = key.trim()
      const v = value.trim()
      if (k === '' && v === '') continue       // empty trailing row — skip silently
      if (k === '') {
        setTagError(t('cmdb.tagKeyEmpty', { n: i + 1 }))
        return
      }
      if (seen.has(k)) {
        setTagError(t('cmdb.tagDuplicateKey', { key: k }))
        return
      }
      seen.add(k)
      cleaned[k] = v
    }
    setTagError('')
    patchTags.mutate(cleaned)
  }

  function cancelTagEdit() {
    setEditingTags(false)
    setTagError('')
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-[480px] bg-gray-900 border-l border-gray-800 z-50 overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-800 sticky top-0 bg-gray-900">
          <div>
            <h2 className="text-lg font-semibold text-white">{ci.display_name || ci.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{ci.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-xl leading-none mt-0.5"
            aria-label={t('cmdb.closeDrawer')}
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Badges + meta row */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <ProviderBadge provider={ci.cloud_provider} />
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  LIFECYCLE_COLORS[ci.lifecycle_state] ?? LIFECYCLE_COLORS.unknown
                }`}
              >
                {t(`lifecycle.${ci.lifecycle_state}`, { defaultValue: ci.lifecycle_state })}
              </span>
            </div>
            <div className="flex gap-6 text-sm text-gray-400">
              {ci.cloud_region && (
                <span>📍 <span className="text-gray-200">{ci.cloud_region}</span></span>
              )}
              {ci.cloud_provider && (
                <span>☁️ <span className="text-gray-200">{providerLabel(ci.cloud_provider)}</span></span>
              )}
            </div>
          </div>

          {/* Parent (T11) */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{t('cmdb.parentCi')}</h3>
              {!editingParent && (
                <button
                  onClick={() => {
                    setParentDraft(ci.parent_ci_id ?? '')
                    setEditingParent(true)
                  }}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  {t('common.edit')}
                </button>
              )}
            </div>
            {editingParent ? (
              <div className="space-y-2" data-testid="ci-parent-editor">
                <select
                  value={parentDraft}
                  onChange={(e) => setParentDraft(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white"
                >
                  <option value="">{t('cmdb.noParent')}</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>{c.display_name || c.name}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button
                    onClick={() => setParentMutation.mutate(parentDraft)}
                    disabled={setParentMutation.isPending}
                    className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs rounded transition-colors"
                  >
                    {t('common.save')}
                  </button>
                  <button
                    onClick={() => setEditingParent(false)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-300">
                {ci.parent_ci_id
                  ? candidates.find((c) => c.id === ci.parent_ci_id)
                    ? (candidates.find((c) => c.id === ci.parent_ci_id) as CI).display_name || (candidates.find((c) => c.id === ci.parent_ci_id) as CI).name
                    : ci.parent_ci_id
                  : <span className="text-gray-600">{t('cmdb.noParent')}</span>}
              </p>
            )}
          </section>

          {/* Metadata */}
          {metaEntries.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{t('cmdb.metadata')}</h3>
              <div className="bg-gray-800/50 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {metaEntries.map(([k, v]) => (
                      <tr key={k} className="border-b border-gray-700/50 last:border-0">
                        <td className="px-3 py-2 text-gray-400 font-medium w-1/3">{k}</td>
                        <td className="px-3 py-2 text-gray-200 break-all">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Tags */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {t('cmdb.tags')} {tagEntries.length > 0 && <span className="text-gray-600">({tagEntries.length})</span>}
              </h3>
              {!editingTags && (
                <button
                  onClick={startTagEdit}
                  data-testid="ci-tags-edit"
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  {t('common.edit')}
                </button>
              )}
            </div>
            {editingTags ? (
              <div className="space-y-2">
                <div className="space-y-1.5" data-testid="ci-tags-editor">
                  {tagDraft.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={row.key}
                        onChange={(e) => updateTagRow(idx, 'key', e.target.value)}
                        placeholder="key"
                        aria-label={t('cmdb.tagKeyAria', { n: idx + 1 })}
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <span className="text-gray-600 text-xs">=</span>
                      <input
                        type="text"
                        value={row.value}
                        onChange={(e) => updateTagRow(idx, 'value', e.target.value)}
                        placeholder="value"
                        aria-label={t('cmdb.tagValueAria', { n: idx + 1 })}
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={() => removeTagRow(idx)}
                        disabled={patchTags.isPending}
                        aria-label={t('cmdb.tagRemoveAria', { n: idx + 1 })}
                        className="text-gray-500 hover:text-red-400 disabled:opacity-30 transition-colors text-base leading-none px-1"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addTagRow}
                  disabled={patchTags.isPending}
                  className="w-full py-1 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 border border-dashed border-gray-700 rounded transition-colors"
                >
                  {t('cmdb.addTag')}
                </button>
                {tagError && (
                  <p className="text-xs text-red-400" data-testid="ci-tags-error">{tagError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveTags}
                    disabled={patchTags.isPending}
                    data-testid="ci-tags-save"
                    className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs rounded transition-colors"
                  >
                    {patchTags.isPending ? t('cmdb.savingTags') : t('common.save')}
                  </button>
                  <button
                    onClick={cancelTagEdit}
                    disabled={patchTags.isPending}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 text-xs rounded transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : tagEntries.length === 0 ? (
              <p className="text-gray-600 text-sm">{t('cmdb.noTags')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tagEntries.map(([k, v]) => (
                  <span key={k} className="px-2 py-0.5 bg-gray-700 text-gray-300 text-xs rounded">
                    {k}={v}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* Associations */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {t('cmdb.associations')} {associations.length > 0 && <span className="text-gray-600">({associations.length})</span>}
              </h3>
              <button
                onClick={() => { setShowAddAssoc(v => !v); setAssocError('') }}
                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {showAddAssoc ? `✕ ${t('common.cancel')}` : t('cmdb.linkCi')}
              </button>
            </div>

            {/* Add association form */}
            {showAddAssoc && (
              <div className="bg-gray-800/70 rounded-lg p-3 mb-3 space-y-2">
                <select
                  value={assocKindId}
                  onChange={e => setAssocKindId(e.target.value)}
                  className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">{t('cmdb.selectAssocType')}</option>
                  {objAssocs.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.kind_name} → {a.dst_type_name}
                    </option>
                  ))}
                </select>
                <select
                  value={assocDstId}
                  onChange={e => setAssocDstId(e.target.value)}
                  className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">{t('cmdb.selectTargetCi')}</option>
                  {dstCIs.map(c => (
                    <option key={c.id} value={c.id}>{c.display_name || c.name}</option>
                  ))}
                </select>
                {assocError && <p className="text-xs text-red-400">{assocError}</p>}
                <button
                  onClick={() => linkMutation.mutate()}
                  disabled={!assocKindId || !assocDstId || linkMutation.isPending}
                  className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs rounded transition-colors"
                >
                  {linkMutation.isPending ? t('cmdb.linking') : t('cmdb.link')}
                </button>
              </div>
            )}

            {associations.length === 0 ? (
              <p className="text-gray-600 text-sm">{t('cmdb.noAssociations')}</p>
            ) : (
              <div className="bg-gray-800/50 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-500 text-xs border-b border-gray-700">
                      <th className="px-3 py-2 text-left">{t('cmdb.colCi')}</th>
                      <th className="px-3 py-2 text-left">{t('cmdb.colType')}</th>
                      <th className="px-3 py-2 text-left">{t('cmdb.colDir')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {associations.map((a) => (
                      <tr key={a.id} className="border-b border-gray-700/50 last:border-0">
                        <td className="px-3 py-2 text-gray-200 font-medium">{a.name}</td>
                        <td className="px-3 py-2 text-gray-400">{a.ci_type ?? '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs ${a.direction === 'outgoing' ? 'text-blue-400' : 'text-purple-400'}`}>
                            {a.direction}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* History */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{t('cmdb.recentHistory')}</h3>
            {history.length === 0 ? (
              <p className="text-gray-600 text-sm">{t('cmdb.noHistory')}</p>
            ) : (
              <div className="space-y-2">
                {history.map((entry) => {
                  const changedFields = entry.update_fields ?? []
                  return (
                    <div key={entry.id} className="bg-gray-800/50 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-300 capitalize">{entry.action}</span>
                        <span className="text-xs text-gray-600">{formatRelativeTime(entry.created_at, t)}</span>
                      </div>
                      {changedFields.length > 0 && (
                        <div className="text-xs text-gray-500">
                          {t('cmdb.fields')} {changedFields.map((f) => {
                            const oldVal = entry.pre_data?.[f]
                            const newVal = entry.cur_data?.[f]
                            return (
                              <span key={f} className="mr-2">
                                <span className="text-gray-400">{f}</span>
                                {oldVal != null && newVal != null && (
                                  <span> <span className="text-red-400/70">{String(oldVal)}</span>→<span className="text-green-400/70">{String(newVal)}</span></span>
                                )}
                              </span>
                            )
                          })}
                        </div>
                      )}
                      {entry.operate_from && (
                        <span className="text-xs text-gray-600">{t('cmdb.via', { source: entry.operate_from })}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <button
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="w-full py-2 mt-2 bg-red-900/40 hover:bg-red-800/50 disabled:opacity-40 text-red-300 text-xs font-medium rounded transition-colors"
          >
            {deleteMutation.isPending ? t('cmdb.deleting') : t('cmdb.deleteCi')}
          </button>
        </div>
      </div>
    </>
  )
}

export default function CMDB() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [lifecycleFilter, setLifecycleFilter] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [selectedCi, setSelectedCi] = useState<CI | null>(null)


  async function applyBulkTags() {
    let tags: Record<string, string>
    try {
      tags = JSON.parse(bulkTagsText || '{}')
    } catch {
      setBulkMessage(t('cmdb.invalidTagsJson'))
      return
    }
    let ok = 0
    let failed = 0
    for (const id of selectedIds) {
      try {
        await api.patch(`/orgs/${orgId}/cis/${id}/tags`, { tags })
        ok++
      } catch {
        failed++
      }
    }
    setBulkMessage(t('cmdb.bulkUpdated', { ok }) + (failed ? `, ${t('cmdb.bulkFailed', { failed })}` : ''))
    setSelectedIds(new Set())
    queryClient.invalidateQueries({ queryKey: ['cis', orgId] })
    setShowBulkModal(false)
  }
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkTagsText, setBulkTagsText] = useState('')
  const [showBulkModal, setShowBulkModal] = useState(false)
  const [bulkMessage, setBulkMessage] = useState('')
  const [form, setForm] = useState<NewCIForm>({
    name: '',
    display_name: '',
    cloud_provider: 'aws',
    cloud_region: '',
    ci_type_id: '',
    meta: {},
  })
  const [formError, setFormError] = useState('')
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  // Dynamic attributes of the selected CI type (rendered as form fields).
  const { data: typeAttrs = [] } = useQuery<CITypeAttribute[]>({
    queryKey: ['ci-type-attrs', orgId, form.ci_type_id],
    enabled: !!orgId && !!form.ci_type_id,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CITypeAttribute[] }>(`/orgs/${orgId}/ci-types/${form.ci_type_id}/attributes`)
      return res.data ?? []
    },
  })

  const { query, rows, page, perPage, totalPages, total, setPage, setPerPage } =
    usePagination<CI>(
      ['cmdb', orgId, search, providerFilter, lifecycleFilter],
      (p, pp) =>
        paginatedGet<CI>(`/orgs/${orgId}/cis`, {
          page: p,
          per_page: pp,
          ...(search ? { search } : {}),
          ...(providerFilter ? { cloud_provider: providerFilter } : {}),
          ...(lifecycleFilter ? { lifecycle_state: lifecycleFilter } : {}),
        }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const { isLoading, isError } = query

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: NewCIForm) =>
      api.post(`/orgs/${orgId}/cis`, {
        name: payload.name,
        display_name: payload.display_name,
        cloud_provider: payload.cloud_provider,
        cloud_region: payload.cloud_region,
        ci_type_id: payload.ci_type_id,
        meta: payload.meta,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
      setForm({ name: '', display_name: '', cloud_provider: 'aws', cloud_region: '', ci_type_id: '', meta: {} })
      setShowForm(false)
      setFormError('')
    },
    onError: () => setFormError(t('cmdb.createFailed')),
  })

  const lifecycleMutation = useMutation({
    mutationFn: ({ ciId, state }: { ciId: string; state: string }) =>
      api.patch(`/orgs/${orgId}/cis/${ciId}/lifecycle`, { to_state: state }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
      setActionError('')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error?.message
      const allowed: string[] | undefined = err?.response?.data?.error?.details?.allowed
      setActionError(
        msg && allowed
          ? `${msg} (${allowed.map((s) => t(`lifecycle.${s}`, { defaultValue: s })).join(', ')})`
          : t('cmdb.lifecycleFailed')
      )
    },
  })

  // T5: trigger CMDB discovery for all active cloud accounts.
  const discoveryMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/cmdb/discovery`),
    onSuccess: (res: any) => {
      const count = res?.data?.data?.jobs_enqueued ?? 0
      setActionError('')
      setDiscoveryMessage(t('cmdb.discoveryTriggered', { count }))
    },
    onError: (err: any) => {
      setDiscoveryMessage(err?.response?.data?.error?.message ?? t('cmdb.discoveryFailed'))
    },
  })
  const [discoveryMessage, setDiscoveryMessage] = useState('')

  // T6: recent CI change events for the "变更动态" card.
  const { data: eventsData } = useQuery<{ data: CiChangeEvent[] }>({
    queryKey: ['cmdb-events', orgId],
    enabled: !!orgId,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CiChangeEvent[] }>(`/orgs/${orgId}/cmdb/events?limit=8`)
      return res
    },
  })
  const recentEvents = eventsData?.data ?? []

  // T9: batch operations on the selected rows.
  const [batchLifecycle, setBatchLifecycle] = useState('')
  const [batchMessage, setBatchMessage] = useState('')

  const batchUpdateMutation = useMutation({
    mutationFn: (payload: { lifecycle_state?: string }) =>
      api.post(`/orgs/${orgId}/cis/batch-update`, { ids: Array.from(selectedIds), ...payload }),
    onSuccess: (res: any) => {
      const d = res?.data?.data
      setBatchMessage(t('cmdb.batchDone', { ok: d?.updated ?? 0, failed: d?.failed ?? 0 }))
      setSelectedIds(new Set())
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
    },
    onError: () => setBatchMessage(t('cmdb.lifecycleFailed')),
  })

  const batchDeleteMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/cis/batch-delete`, { ids: Array.from(selectedIds) }),
    onSuccess: (res: any) => {
      const d = res?.data?.data
      setBatchMessage(t('cmdb.batchDeleted', { ok: d?.deleted ?? 0 }))
      setSelectedIds(new Set())
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
    },
    onError: () => setBatchMessage(t('cmdb.deleteFailed')),
  })

  // T7: export current filters as CSV.
  function exportCsv() {
    const params = new URLSearchParams({ format: 'csv' })
    if (search) params.set('search', search)
    if (providerFilter) params.set('cloud_provider', providerFilter)
    if (lifecycleFilter) params.set('lifecycle_state', lifecycleFilter)
    window.open(`/api/v1/orgs/${orgId}/cis/export?${params.toString()}`, '_blank')
  }

  const [actionError, setActionError] = useState('')

  // Search / provider / lifecycle filters run server-side; this is the page slice.
  const safeData: CI[] = Array.isArray(rows) ? rows : []
  const filtered = safeData

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    createMutation.mutate(form)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('cmdb.title')}</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => discoveryMutation.mutate()}
            disabled={discoveryMutation.isPending}
            data-testid="cmdb-trigger-discovery"
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 text-sm font-medium rounded-lg transition-colors"
          >
            {discoveryMutation.isPending ? t('cmdb.discoveryTriggering') : t('cmdb.triggerDiscovery')}
          </button>
          <button
            onClick={exportCsv}
            data-testid="cmdb-export-csv"
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium rounded-lg transition-colors"
          >
            {t('cmdb.exportCsv')}
          </button>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {showForm ? t('common.cancel') : t('cmdb.newCi')}
          </button>
        </div>
      </div>

      {discoveryMessage && (
        <div className="mb-4 p-3 rounded-lg bg-green-900/40 border border-green-700 text-green-300 text-sm" data-testid="cmdb-discovery-message">
          {discoveryMessage}
        </div>
      )}

      {/* Create CI form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-200 mb-4">{t('cmdb.newCiTitle')}</h3>
          {formError && (
            <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">{formError}</div>
          )}
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('common.name')} *</label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="i-1234567890"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('cmdb.displayName')}</label>
              <input
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Web Server"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('cmdb.ciType')}</label>
              <select
                value={form.ci_type_id}
                onChange={(e) => setForm({ ...form, ci_type_id: e.target.value, meta: {} })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{t('cmdb.selectType')}</option>
                {ciTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.display_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('cmdb.provider')}</label>
              <select
                value={form.cloud_provider}
                onChange={(e) => setForm({ ...form, cloud_provider: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {CLOUD_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{providerLabel(p)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('cmdb.region')}</label>
              <input
                value={form.cloud_region}
                onChange={(e) => setForm({ ...form, cloud_region: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="us-east-1"
              />
            </div>
            {typeAttrs.map((attr) => (
              <div key={attr.id}>
                <label className="block text-xs text-gray-400 mb-1">
                  {attr.display_name || attr.name}
                  {attr.is_required ? ' *' : ''}
                </label>
                <input
                  value={form.meta[attr.name] ?? ''}
                  onChange={(e) => setForm({ ...form, meta: { ...form.meta, [attr.name]: e.target.value } })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder={attr.name}
                />
              </div>
            ))}
            <div className="flex items-end">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="w-full px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {createMutation.isPending ? t('cmdb.creating') : t('cmdb.createCi')}
              </button>
            </div>
          </form>
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('cmdb.loadFailed')}
        </div>
      )}

      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <input
          type="text"
          placeholder={t('cmdb.searchPlaceholderFull')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[160px] max-w-xs px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">{t('cmdb.allProviders')}</option>
          {CLOUD_PROVIDERS.map((p) => (
            <option key={p} value={p}>{providerLabel(p)}</option>
          ))}
        </select>
        <select
          value={lifecycleFilter}
          onChange={(e) => setLifecycleFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">{t('cmdb.allStates')}</option>
          {LIFECYCLE_STATES.map((s) => (
            <option key={s} value={s}>{t(`lifecycle.${s}`)}</option>
          ))}
        </select>
      </div>

      {/* 变更动态 (T6) */}
      {recentEvents.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {t('cmdb.recentChanges')}
            </h3>
            <span className="text-xs text-gray-600">{t('cmdb.recentChangesHint')}</span>
          </div>
          <div className="space-y-1" data-testid="cmdb-events-card">
            {recentEvents.slice(0, 6).map((ev) => (
              <div key={ev.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${
                    ev.event_type === 'ci.created'
                      ? 'bg-green-900/40 text-green-300'
                      : ev.event_type === 'ci.deleted'
                        ? 'bg-red-900/40 text-red-300'
                        : ev.event_type === 'ci.lifecycle_changed'
                          ? 'bg-purple-900/40 text-purple-300'
                          : 'bg-blue-900/40 text-blue-300'
                  }`}
                >
                  {t(`cmdb.eventType.${ev.event_type}`, { defaultValue: ev.event_type })}
                </span>
                <span className="text-gray-200 truncate">{ev.ci_name ?? ev.ci_id}</span>
                <span className="text-gray-600 ml-auto whitespace-nowrap">{formatRelativeTime(ev.created_at, t)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Batch toolbar (T9) */}
      {selectedIds.size > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-indigo-950/40 border border-indigo-800 flex flex-wrap items-center gap-3" data-testid="cmdb-batch-bar">
          <span className="text-sm text-indigo-200">{t('cmdb.selectedCount', { count: selectedIds.size })}</span>
          <button
            onClick={() => setShowBulkModal(true)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs rounded-lg transition-colors"
          >
            {t('cmdb.editTags', { count: selectedIds.size })}
          </button>
          <select
            value={batchLifecycle}
            onChange={(e) => {
              if (e.target.value) {
                batchUpdateMutation.mutate({ lifecycle_state: e.target.value })
                setBatchLifecycle('')
              }
            }}
            className="px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-gray-300 text-xs focus:outline-none"
          >
            <option value="">{t('cmdb.batchLifecycle')}</option>
            {LIFECYCLE_STATES.filter((st) => st !== 'unknown').map((st) => (
              <option key={st} value={st}>{t(`lifecycle.${st}`, { defaultValue: st })}</option>
            ))}
          </select>
          <button
            onClick={() => {
              if (window.confirm(t('cmdb.batchDeleteConfirm', { count: selectedIds.size }))) {
                batchDeleteMutation.mutate()
              }
            }}
            className="px-3 py-1.5 bg-red-900/40 hover:bg-red-800/50 text-red-300 text-xs rounded-lg transition-colors"
          >
            {t('cmdb.batchDelete')}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-gray-400 hover:text-gray-200 ml-auto"
          >
            {t('cmdb.clearSelection')}
          </button>
        </div>
      )}

      {batchMessage && (
        <div className="mb-4 p-3 rounded-lg bg-blue-900/40 border border-blue-700 text-blue-300 text-sm">
          {batchMessage}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-left">
              <th className="px-2 py-3 w-8">
                {selectedIds.size > 0 && (
                  <button
                    onClick={() => setShowBulkModal(true)}
                    className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded transition-colors"
                  >
                    {t('cmdb.editTags', { count: selectedIds.size })}
                  </button>
                )}
              </th>
              <th className="px-4 py-3 font-medium">{t('common.name')}</th>
              <th className="px-4 py-3 font-medium">{t('cmdb.provider')}</th>
              <th className="px-4 py-3 font-medium">{t('cmdb.region')}</th>
              <th className="px-4 py-3 font-medium">{t('cmdb.lifecycle')}</th>
              <th className="px-4 py-3 font-medium">{t('cmdb.tags')}</th>
              <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">{t('common.loading')}</td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">{t('cmdb.noCis')}</td>
              </tr>
            ) : (
              filtered.map((ci) => (
                <tr
                  key={ci.id}
                  className={`border-b border-gray-800 hover:bg-gray-800/50 transition-colors cursor-pointer ${
                    selectedIds.has(ci.id) ? 'bg-indigo-900/20' : ''
                  }`}
                  onClick={() => setSelectedCi(ci)}
                >
                  <td className="px-2 py-3 w-8" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(ci.id)}
                      onChange={() =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(ci.id)) next.delete(ci.id)
                          else next.add(ci.id)
                          return next
                        })
                      }
                      className="rounded border-gray-600 bg-gray-800 text-indigo-500"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">{ci.display_name || ci.name}</p>
                    <p className="text-xs text-gray-500">{ci.name}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs font-medium">{providerLabel(ci.cloud_provider)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{ci.cloud_region}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${LIFECYCLE_COLORS[ci.lifecycle_state] ?? LIFECYCLE_COLORS.unknown}`}>
                      {t(`lifecycle.${ci.lifecycle_state}`, { defaultValue: ci.lifecycle_state })}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(ci.tags ?? {}).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="px-1.5 py-0.5 bg-gray-700 text-gray-300 text-xs rounded">
                          {k}={v}
                        </span>
                      ))}
                      {Object.keys(ci.tags ?? {}).length > 3 && (
                        <span className="text-xs text-gray-500">+{Object.keys(ci.tags).length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {legalSuccessors(ci.lifecycle_state).length > 0 ? (
                      <select
                        defaultValue=""
                        data-testid={`ci-transition-${ci.id}`}
                        onChange={(e) => {
                          if (e.target.value) {
                            lifecycleMutation.mutate({ ciId: ci.id, state: e.target.value })
                            e.target.value = ''
                          }
                        }}
                        className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-300 text-xs focus:outline-none"
                      >
                        <option value="" disabled>{t('cmdb.transition')}</option>
                        {legalSuccessors(ci.lifecycle_state).map((s) => (
                          <option key={s} value={s}>{t(`lifecycle.${s}`, { defaultValue: s })}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-gray-600">{t('cmdb.terminalState')}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {total > 0 && (
          <PaginationBar
            page={page}
            totalPages={totalPages}
            total={total}
            perPage={perPage}
            onPageChange={setPage}
            onPerPageChange={setPerPage}
          />
        )}
      </div>

      {/* CI Detail Drawer */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowBulkModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">{t('cmdb.editTagsTitle', { count: selectedIds.size })}</h3>
            <textarea
              value={bulkTagsText}
              onChange={(e) => setBulkTagsText(e.target.value)}
              rows={6}
              placeholder={'{"env": "prod", "team": "platform"}'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {bulkMessage && <p className="text-xs text-yellow-300 mt-2">{bulkMessage}</p>}
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => setShowBulkModal(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">{t('common.cancel')}</button>
              <button onClick={applyBulkTags} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">{t('cmdb.applyToAll')}</button>
            </div>
          </div>
        </div>
      )}

      {selectedCi && (
        <CIDrawer ci={selectedCi} onClose={() => setSelectedCi(null)} />
      )}
    </div>
  )
}
