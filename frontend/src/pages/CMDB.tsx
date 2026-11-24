import { InputGroup } from '@cloudflare/kumo/components/input-group'
import { Search } from 'lucide-react'
import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useId, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useTranslation } from 'react-i18next'
import { useOrgStore } from '../store/orgStore'
import { ProviderBadge } from '../components/shared/ProviderBadge'
import { CiPicker } from '../components/shared/CiPicker'
import { CLOUD_PROVIDERS, providerLabel } from '../lib/providers'
import type { CI } from '../types'

const LIFECYCLE_COLORS: Record<string, string> = {
  active: 'bg-success/10 text-success',
  stopped: 'bg-warning/10 text-warning',
  terminated: 'bg-danger/10 text-danger',
  unknown: 'bg-emphasis text-secondary',
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
  const assocTypeControl = useId()
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
  const selectedMapping = objAssocs.find(a => a.id === assocKindId)

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
      api.put(`/orgs/${orgId}/cis/${ci.id}`, parentId
        ? { parent_ci_id: parentId }
        : { remove_parent: true }),
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
    <NativeDialog className="justify-end" label={ci.display_name || ci.name} onClose={onClose}>
      {/* Backdrop */}

      {/* Drawer */}
      <div className="drawer-panel max-w-[480px]">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-edge sticky top-0 bg-surface">
          <div>
            <h2 className="text-lg font-semibold text-primary">{ci.display_name || ci.name}</h2>
            <p className="text-xs text-muted mt-0.5">{ci.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-secondary hover:text-primary transition-colors text-xl leading-none mt-0.5"
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
            <div className="flex gap-6 text-sm text-secondary">
              {ci.cloud_region && (
                <span>📍 <span className="text-primary">{ci.cloud_region}</span></span>
              )}
              {ci.cloud_provider && (
                <span>☁️ <span className="text-primary">{providerLabel(ci.cloud_provider)}</span></span>
              )}
            </div>
          </div>

          {/* Parent (T11) */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">{t('cmdb.parentCi')}</h3>
              {!editingParent && (
                <button
                  onClick={() => {
                    setParentDraft(ci.parent_ci_id ?? '')
                    setEditingParent(true)
                  }}
                  className="text-xs text-accent hover:text-accent transition-colors"
                >
                  {t('common.edit')}
                </button>
              )}
            </div>
            {editingParent ? (
              <div className="space-y-2" data-testid="ci-parent-editor">
                <SelectField
                  value={parentDraft}
                  onValueChange={setParentDraft}
                  className="w-full"
                  aria-label={t('cmdb.noParent')}
                  items={[
                    { value: "", label: t('cmdb.noParent') },
                    ...candidates.map((c) => ({ value: c.id, label: c.display_name || c.name })),
                  ]}
                />
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => setParentMutation.mutate(parentDraft)}
                    disabled={setParentMutation.isPending}
                    className="flex-1"
                  >
                    {t('common.save')}
                  </Button>
                  <Button
                    onClick={() => setEditingParent(false)}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-secondary">
                {ci.parent_ci_id
                  ? candidates.find((c) => c.id === ci.parent_ci_id)
                    ? (candidates.find((c) => c.id === ci.parent_ci_id) as CI).display_name || (candidates.find((c) => c.id === ci.parent_ci_id) as CI).name
                    : ci.parent_ci_id
                  : <span className="text-muted">{t('cmdb.noParent')}</span>}
              </p>
            )}
          </section>

          {/* Metadata */}
          {metaEntries.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-2">{t('cmdb.metadata')}</h3>
              <div className="bg-subtle/50 rounded-lg overflow-hidden">
                <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                  <Table.Body>
                    {metaEntries.map(([k, v]) => (
                      <Table.Row key={k} className="border-b border-strong/50 last:border-0">
                        <Table.Cell className="px-3 py-2 text-secondary font-medium w-1/3">{k}</Table.Cell>
                        <Table.Cell className="px-3 py-2 text-primary break-all">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table></div>
              </div>
            </section>
          )}

          {/* Tags */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">
                {t('cmdb.tags')} {tagEntries.length > 0 && <span className="text-muted">({tagEntries.length})</span>}
              </h3>
              {!editingTags && (
                <button
                  onClick={startTagEdit}
                  data-testid="ci-tags-edit"
                  className="text-xs text-accent hover:text-accent transition-colors"
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
                      <Input
                        type="text"
                        value={row.key}
                        onChange={(e) => updateTagRow(idx, 'key', e.target.value)}
                        placeholder="key"
                        aria-label={t('cmdb.tagKeyAria', { n: idx + 1 })}
                        className="flex-1 min-w-0 font-mono"
                      />
                      <span className="text-muted text-xs">=</span>
                      <Input
                        type="text"
                        value={row.value}
                        onChange={(e) => updateTagRow(idx, 'value', e.target.value)}
                        placeholder="value"
                        aria-label={t('cmdb.tagValueAria', { n: idx + 1 })}
                        className="flex-1 min-w-0 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => removeTagRow(idx)}
                        disabled={patchTags.isPending}
                        aria-label={t('cmdb.tagRemoveAria', { n: idx + 1 })}
                        className="text-muted hover:text-danger disabled:opacity-30 transition-colors text-base leading-none px-1"
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
                  className="w-full py-1 text-xs text-accent hover:text-accent disabled:opacity-40 border border-dashed border-strong rounded transition-colors"
                >
                  {t('cmdb.addTag')}
                </button>
                {tagError && (
                  <p className="text-xs text-danger" data-testid="ci-tags-error">{tagError}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={handleSaveTags}
                    disabled={patchTags.isPending}
                    data-testid="ci-tags-save"
                    className="flex-1"
                  >
                    {patchTags.isPending ? t('cmdb.savingTags') : t('common.save')}
                  </Button>
                  <Button
                    onClick={cancelTagEdit}
                    disabled={patchTags.isPending}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : tagEntries.length === 0 ? (
              <p className="text-muted text-sm">{t('cmdb.noTags')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tagEntries.map(([k, v]) => (
                  <span key={k} className="px-2 py-0.5 bg-emphasis text-secondary text-xs rounded">
                    {k}={v}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* Associations */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">
                {t('cmdb.associations')} {associations.length > 0 && <span className="text-muted">({associations.length})</span>}
              </h3>
              <button
                onClick={() => { setShowAddAssoc(v => !v); setAssocError('') }}
                className="text-xs text-accent hover:text-accent transition-colors"
              >
                {showAddAssoc ? `✕ ${t('common.cancel')}` : t('cmdb.linkCi')}
              </button>
            </div>

            {/* Add association form */}
            {showAddAssoc && (
              <form
                className="bg-subtle/70 rounded-lg p-3 mb-3 space-y-2"
                onSubmit={event => {
                  event.preventDefault()
                  if (selectedMapping && assocDstId && !linkMutation.isPending) linkMutation.mutate()
                }}
              >
                <SelectField
                  label={t('cmdb.associations')}
                  id={assocTypeControl}
                  name="associationType"
                  required
                  value={assocKindId}
                  onValueChange={value => {
                    setAssocKindId(value)
                    setAssocDstId('')
                    setAssocError('')
                  }}
                  className="w-full"
                  items={[
                    { value: "", label: t('cmdb.selectAssocType') },
                    ...objAssocs.map(a => ({ value: a.id, label: `${a.kind_name} → ${a.dst_type_name}` })),
                  ]}
                />
                {orgId && selectedMapping && (
                  <CiPicker
                    key={selectedMapping.id}
                    orgId={orgId}
                    ciTypeId={selectedMapping.dst_ci_type_id}
                    excludeIds={[ci.id]}
                    value={assocDstId}
                    onChange={setAssocDstId}
                    placeholder={t('cmdb.selectTargetCi')}
                  />
                )}
                {assocError && <p role="alert" className="text-xs text-danger">{assocError}</p>}
                <Button
                  variant="primary"
                  type="submit"
                  disabled={linkMutation.isPending}
                  className="w-full"
                >
                  {linkMutation.isPending ? t('cmdb.linking') : t('cmdb.link')}
                </Button>
              </form>
            )}

            {associations.length === 0 ? (
              <p className="text-muted text-sm">{t('cmdb.noAssociations')}</p>
            ) : (
              <div className="bg-subtle/50 rounded-lg overflow-hidden">
                <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                  <Table.Header variant="compact">
                    <Table.Row className="text-muted text-xs border-b border-strong">
                      <Table.Head className="px-3 py-2 text-left">{t('cmdb.colCi')}</Table.Head>
                      <Table.Head className="px-3 py-2 text-left">{t('cmdb.colType')}</Table.Head>
                      <Table.Head className="px-3 py-2 text-left">{t('cmdb.colDir')}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {associations.map((a) => (
                      <Table.Row key={a.id} className="border-b border-strong/50 last:border-0">
                        <Table.Cell className="px-3 py-2 text-primary font-medium">{a.name}</Table.Cell>
                        <Table.Cell className="px-3 py-2 text-secondary">{a.ci_type ?? '—'}</Table.Cell>
                        <Table.Cell className="px-3 py-2">
                          <span className={`text-xs ${a.direction === 'outgoing' ? 'text-info' : 'text-violet'}`}>
                            {a.direction}
                          </span>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table></div>
              </div>
            )}
          </section>

          {/* History */}
          <section>
            <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-2">{t('cmdb.recentHistory')}</h3>
            {history.length === 0 ? (
              <p className="text-muted text-sm">{t('cmdb.noHistory')}</p>
            ) : (
              <div className="space-y-2">
                {history.map((entry) => {
                  const changedFields = entry.update_fields ?? []
                  return (
                    <div key={entry.id} className="bg-subtle/50 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-secondary capitalize">{entry.action}</span>
                        <span className="text-xs text-muted">{formatRelativeTime(entry.created_at, t)}</span>
                      </div>
                      {changedFields.length > 0 && (
                        <div className="text-xs text-muted">
                          {t('cmdb.fields')} {changedFields.map((f) => {
                            const oldVal = entry.pre_data?.[f]
                            const newVal = entry.cur_data?.[f]
                            return (
                              <span key={f} className="mr-2">
                                <span className="text-secondary">{f}</span>
                                {oldVal != null && newVal != null && (
                                  <span> <span className="text-danger/70">{String(oldVal)}</span>→<span className="text-success/70">{String(newVal)}</span></span>
                                )}
                              </span>
                            )
                          })}
                        </div>
                      )}
                      {entry.operate_from && (
                        <span className="text-xs text-muted">{t('cmdb.via', { source: entry.operate_from })}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <Button
            variant="secondary-destructive" size="sm"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="w-full mt-2"
          >
            {deleteMutation.isPending ? t('cmdb.deleting') : t('cmdb.deleteCi')}
          </Button>
        </div>
      </div>
    </NativeDialog>
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
      <div className="page-header">
        <h1 className="page-title">{t('cmdb.title')}</h1>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => discoveryMutation.mutate()}
            disabled={discoveryMutation.isPending}
            data-testid="cmdb-trigger-discovery"
          >
            {discoveryMutation.isPending ? t('cmdb.discoveryTriggering') : t('cmdb.triggerDiscovery')}
          </Button>
          <Button
            onClick={exportCsv}
            data-testid="cmdb-export-csv"
          >
            {t('cmdb.exportCsv')}
          </Button>
          <Button
            variant={showForm ? 'secondary' : 'primary'}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? t('common.cancel') : t('cmdb.newCi')}
          </Button>
        </div>
      </div>

      {discoveryMessage && (
        <div className="mb-4 p-3 rounded-lg bg-success/10 border border-success/25 text-success text-sm" data-testid="cmdb-discovery-message">
          {discoveryMessage}
        </div>
      )}

      {/* Create CI form */}
      {showForm && (
        <div className="bg-surface border border-edge rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-primary mb-4">{t('cmdb.newCiTitle')}</h3>
          {formError && (
            <div className="mb-3 p-2 rounded bg-danger/10 border border-danger/25 text-danger text-sm">{formError}</div>
          )}
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Input label={`${t('common.name')} *`}
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full"
                placeholder="i-1234567890"
              />
            </div>
            <div>
              <Input
                label={t('cmdb.displayName')}
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                className="w-full"
                placeholder="Web Server"
              />
            </div>
            <div>
              <SelectField
                label={t('cmdb.ciType')}
                value={form.ci_type_id}
                onValueChange={value => setForm({ ...form, ci_type_id: value, meta: {} })}
                className="w-full"
                items={[
                  { value: "", label: t('cmdb.selectType') },
                  ...ciTypes.map((t) => ({ value: t.id, label: t.display_name })),
                ]}
              />
            </div>
            <div>
              <SelectField
                label={t('cmdb.provider')}
                value={form.cloud_provider}
                onValueChange={value => setForm({ ...form, cloud_provider: value })}
                className="w-full"
                items={CLOUD_PROVIDERS.map((p) => ({ value: p, label: providerLabel(p) }))}
              />
            </div>
            <div>
              <Input
                label={t('cmdb.region')}
                value={form.cloud_region}
                onChange={(e) => setForm({ ...form, cloud_region: e.target.value })}
                className="w-full"
                placeholder="us-east-1"
              />
            </div>
            {typeAttrs.map((attr) => (
              <div key={attr.id}>
                <Input
                  label={`${attr.display_name || attr.name}${attr.is_required ? ' *' : ''}`}
                  value={form.meta[attr.name] ?? ''}
                  onChange={(e) => setForm({ ...form, meta: { ...form.meta, [attr.name]: e.target.value } })}
                  className="w-full"
                  placeholder={attr.name}
                />
              </div>
            ))}
            <div className="flex items-end">
              <Button
                variant="primary"
                type="submit"
                disabled={createMutation.isPending}
                className="w-full"
              >
                {createMutation.isPending ? t('cmdb.creating') : t('cmdb.createCi')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('cmdb.loadFailed')}
        </div>
      )}

      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <InputGroup className="flex-1 min-w-[160px] max-w-xs">
          <InputGroup.Addon><Search size={16} aria-hidden="true" /></InputGroup.Addon>
          <InputGroup.Input
            aria-label={t('cmdb.searchPlaceholderFull')}
            type="text"
            placeholder={t('cmdb.searchPlaceholderFull')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
        <SelectField
          value={providerFilter}
          onValueChange={setProviderFilter}
          aria-label={t('cmdb.allProviders')}
          items={[
            { value: "", label: t('cmdb.allProviders') },
            ...CLOUD_PROVIDERS.map((p) => ({ value: p, label: providerLabel(p) })),
          ]}
        />
        <SelectField
          value={lifecycleFilter}
          onValueChange={setLifecycleFilter}
          aria-label={t('cmdb.allStates')}
          items={[
            { value: "", label: t('cmdb.allStates') },
            ...LIFECYCLE_STATES.map((s) => ({ value: s, label: t(`lifecycle.${s}`) })),
          ]}
        />
      </div>

      {/* 变更动态 (T6) */}
      {recentEvents.length > 0 && (
        <div className="bg-surface border border-edge rounded-xl p-4 mb-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">
              {t('cmdb.recentChanges')}
            </h3>
            <span className="text-xs text-muted">{t('cmdb.recentChangesHint')}</span>
          </div>
          <div className="space-y-1" data-testid="cmdb-events-card">
            {recentEvents.slice(0, 6).map((ev) => (
              <div key={ev.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${
                    ev.event_type === 'ci.created'
                      ? 'bg-success/10 text-success'
                      : ev.event_type === 'ci.deleted'
                        ? 'bg-danger/10 text-danger'
                        : ev.event_type === 'ci.lifecycle_changed'
                          ? 'bg-violet/10 text-violet'
                          : 'bg-info/10 text-info'
                  }`}
                >
                  {t(`cmdb.eventType.${ev.event_type}`, { defaultValue: ev.event_type })}
                </span>
                <span className="text-primary truncate">{ev.ci_name ?? ev.ci_id}</span>
                <span className="text-muted ml-auto whitespace-nowrap">{formatRelativeTime(ev.created_at, t)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Batch toolbar (T9) */}
      {selectedIds.size > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-accent-soft/40 border border-accent flex flex-wrap items-center gap-3" data-testid="cmdb-batch-bar">
          <span className="text-sm text-accent">{t('cmdb.selectedCount', { count: selectedIds.size })}</span>
          <Button
            size="sm"
            onClick={() => setShowBulkModal(true)}
          >
            {t('cmdb.editTags', { count: selectedIds.size })}
          </Button>
          <SelectField
            value={batchLifecycle}
            onValueChange={value => {
              if (value) {
                batchUpdateMutation.mutate({ lifecycle_state: value })
                setBatchLifecycle('')
              }
            }}
            aria-label={t('cmdb.batchLifecycle')}
            items={[
              { value: "", label: t('cmdb.batchLifecycle') },
              ...LIFECYCLE_STATES.filter((st) => st !== 'unknown').map((st) => ({ value: st, label: t(`lifecycle.${st}`, { defaultValue: st }) })),
            ]}
          />
          <Button
            variant="secondary-destructive" size="sm"
            onClick={() => {
              if (window.confirm(t('cmdb.batchDeleteConfirm', { count: selectedIds.size }))) {
                batchDeleteMutation.mutate()
              }
            }}
          >
            {t('cmdb.batchDelete')}
          </Button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-secondary hover:text-primary ml-auto"
          >
            {t('cmdb.clearSelection')}
          </button>
        </div>
      )}

      {batchMessage && (
        <div className="mb-4 p-3 rounded-lg bg-info/10 border border-info/25 text-info text-sm">
          {batchMessage}
        </div>
      )}

      <div className="bg-surface border border-edge rounded-xl overflow-hidden">
        <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
          <Table.Header variant="compact">
            <Table.Row className="border-b border-edge text-secondary text-left">
              <Table.Head className="px-2 py-3 w-8">
                {selectedIds.size > 0 && (
                  <Button
                    variant="primary"
                    onClick={() => setShowBulkModal(true)}
                  >
                    {t('cmdb.editTags', { count: selectedIds.size })}
                  </Button>
                )}
              </Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('cmdb.provider')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('cmdb.region')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('cmdb.lifecycle')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('cmdb.tags')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {isLoading ? (
              <Table.Row>
                <Table.Cell colSpan={7} className="px-4 py-8 text-center text-muted">{t('common.loading')}</Table.Cell>
              </Table.Row>
            ) : filtered.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={7} className="px-4 py-8 text-center text-muted">{t('cmdb.noCis')}</Table.Cell>
              </Table.Row>
            ) : (
              filtered.map((ci) => (
                <Table.Row
                  key={ci.id}
                  className={`border-b border-edge hover:bg-subtle/50 transition-colors cursor-pointer ${
                    selectedIds.has(ci.id) ? 'bg-accent-soft/20' : ''
                  }`}
                  onClick={() => setSelectedCi(ci)}
                >
                  <Table.Cell className="px-2 py-3 w-8" onClick={(e) => e.stopPropagation()}>
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
                      className="rounded border-strong bg-subtle text-accent"
                    />
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <p className="font-medium text-primary">{ci.display_name || ci.name}</p>
                    <p className="text-xs text-muted">{ci.name}</p>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs font-medium">{providerLabel(ci.cloud_provider)}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{ci.cloud_region}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${LIFECYCLE_COLORS[ci.lifecycle_state] ?? LIFECYCLE_COLORS.unknown}`}>
                      {t(`lifecycle.${ci.lifecycle_state}`, { defaultValue: ci.lifecycle_state })}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(ci.tags ?? {}).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="px-1.5 py-0.5 bg-emphasis text-secondary text-xs rounded">
                          {k}={v}
                        </span>
                      ))}
                      {Object.keys(ci.tags ?? {}).length > 3 && (
                        <span className="text-xs text-muted">+{Object.keys(ci.tags).length - 3}</span>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {legalSuccessors(ci.lifecycle_state).length > 0 ? (
                      <SelectField
                        value={null}
                        data-testid={`ci-transition-${ci.id}`}
                        onValueChange={state => lifecycleMutation.mutate({ ciId: ci.id, state })}
                        size="sm"
                        placeholder={t('cmdb.transition')}
                        aria-label={t('cmdb.transition')}
                        items={legalSuccessors(ci.lifecycle_state).map((s) => ({ value: s, label: t(`lifecycle.${s}`, { defaultValue: s }) }))}
                      />
                    ) : (
                      <span className="text-xs text-muted">{t('cmdb.terminalState')}</span>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table></div>
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
        <NativeDialog className="items-center justify-center p-4" label={t('cmdb.editTagsTitle', { count: selectedIds.size })} onClose={() => setShowBulkModal(false)}>
          <div className="dialog-panel p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-primary mb-2">{t('cmdb.editTagsTitle', { count: selectedIds.size })}</h3>
            <InputArea
              aria-label={t('cmdb.editTagsTitle', { count: selectedIds.size })}
              value={bulkTagsText}
              onChange={(e) => setBulkTagsText(e.target.value)}
              rows={6}
              placeholder={'{"env": "prod", "team": "platform"}'}
              className="w-full font-mono resize-y"
            />
            {bulkMessage && <p className="text-xs text-warning mt-2">{bulkMessage}</p>}
            <div className="flex justify-end gap-3 mt-4">
              <Button variant="ghost" onClick={() => setShowBulkModal(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={applyBulkTags}>{t('cmdb.applyToAll')}</Button>
            </div>
          </div>
        </NativeDialog>
      )}

      {selectedCi && (
        <CIDrawer ci={selectedCi} onClose={() => setSelectedCi(null)} />
      )}
    </div>
  )
}
