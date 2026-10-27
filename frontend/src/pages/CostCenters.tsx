import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'
import type { CostCenter } from '../types'

interface BusinessCapability {
  id: string
  name: string
  description?: string
  cost_center_id?: string | null
  cost_center_code?: string | null
  cost_center_name?: string | null
}

interface CostCenterForm {
  name: string
  code: string
  description: string
  parent_id: string
  owner: string
}

const DEFAULT_FORM: CostCenterForm = {
  name: '',
  code: '',
  description: '',
  parent_id: '',
  owner: '',
}

function buildTree(items: CostCenter[]): CostCenter[] {
  const map = new Map<string, CostCenter>()
  const roots: CostCenter[] = []

  for (const item of items) {
    map.set(item.id, { ...item, children: [] })
  }

  for (const item of map.values()) {
    if (item.parent_id && map.has(item.parent_id)) {
      const parent = map.get(item.parent_id)!
      parent.children = parent.children ?? []
      parent.children.push(item)
    } else {
      roots.push(item)
    }
  }

  return roots
}

function CostCenterRow({
  node,
  depth,
  onEdit,
  onDelete,
  onAddChild,
  isDeleting,
}: {
  node: CostCenter
  depth: number
  onEdit: (node: CostCenter) => void
  onDelete: (id: string) => void
  onAddChild: (parentId: string) => void
  isDeleting: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      <div
        className="flex items-center justify-between py-3 border-b border-edge last:border-0 hover:bg-subtle/30 transition-colors"
        style={{ paddingLeft: `${1.25 + depth * 1.5}rem` }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-muted flex-shrink-0">
            {depth === 0 ? '🏢' : '📁'}
          </span>
          <div className="min-w-0">
            <span className="font-medium text-primary text-sm">{node.name}</span>
            {node.code && (
              <span className="ml-2 text-xs text-muted font-mono">[{node.code}]</span>
            )}
            {node.owner && (
              <span className="ml-2 text-xs text-muted">· {node.owner}</span>
            )}
            {node.description && (
              <p className="text-xs text-muted mt-0.5 truncate">{node.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0 ml-4">
          {node.current_cost !== undefined && (
            <span className="text-sm font-semibold text-accent">
              ${node.current_cost.toLocaleString(undefined, { maximumFractionDigits: 0 })} MTD
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => onAddChild(node.id)}
              className="text-xs text-muted hover:text-accent transition-colors"
              title={t('costCenters.addChildTitle')}
            >
              {t('costCenters.addChild')}
            </button>
            <button
              onClick={() => onEdit(node)}
              className="text-xs text-accent hover:text-accent"
            >
              {t('common.edit')}
            </button>
            <button
              onClick={() => onDelete(node.id)}
              disabled={isDeleting}
              className="text-xs text-danger hover:text-danger disabled:opacity-50"
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      </div>
      {node.children?.map((child) => (
        <CostCenterRow
          key={child.id}
          node={child}
          depth={depth + 1}
          onEdit={onEdit}
          onDelete={onDelete}
          onAddChild={onAddChild}
          isDeleting={isDeleting}
        />
      ))}
    </>
  )
}

export default function CostCenters() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CostCenterForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { data: costCenters = [], isLoading, isError } = useQuery<CostCenter[]>({
    queryKey: ['cost-centers', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CostCenter[] }>(
        `/orgs/${orgId}/cost-centers`
      )
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: CostCenterForm) =>
      api.post(`/orgs/${orgId}/cost-centers`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cost-centers', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('costCenters.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CostCenterForm }) =>
      api.put(`/cost-centers/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cost-centers', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('costCenters.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/cost-centers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cost-centers', orgId] }),
  })

  // ── Business capabilities (T17) ──
  const [showCapModal, setShowCapModal] = useState(false)
  const [capForm, setCapForm] = useState({ name: '', description: '', cost_center_id: '' })
  const [capError, setCapError] = useState('')

  const { data: capabilities = [] } = useQuery<BusinessCapability[]>({
    queryKey: ['business-capabilities', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: BusinessCapability[] }>(`/orgs/${orgId}/business-capabilities`)
      return res.data ?? []
    },
  })

  const createCapMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/business-capabilities`, {
        name: capForm.name.trim(),
        description: capForm.description.trim() || undefined,
        cost_center_id: capForm.cost_center_id || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-capabilities', orgId] })
      setShowCapModal(false)
      setCapForm({ name: '', description: '', cost_center_id: '' })
      setCapError('')
    },
    onError: (err: any) => setCapError(err?.response?.data?.error?.message ?? t('costCenters.capCreateFailed')),
  })

  const deleteCapMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/business-capabilities/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['business-capabilities', orgId] }),
  })

  function openCreate(parentId?: string) {
    setEditingId(null)
    setForm({ ...DEFAULT_FORM, parent_id: parentId ?? '' })
    setFormError('')
    setShowModal(true)
  }

  function openEdit(node: CostCenter) {
    setEditingId(node.id)
    setForm({
      name: node.name,
      code: node.code,
      description: node.description ?? '',
      parent_id: node.parent_id ?? '',
      owner: node.owner ?? '',
    })
    setFormError('')
    setShowModal(true)
  }

  function closeModal() {
    setShowModal(false)
    setEditingId(null)
    setFormError('')
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload: form })
    } else {
      createMutation.mutate(form)
    }
  }

  const tree = buildTree(costCenters)

  const inputCls =
    'bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm w-full focus:outline-none focus:ring-2 focus:ring-accent'

  const totalCost = costCenters
    .filter((cc) => !cc.parent_id)
    .reduce((s, cc) => s + (cc.current_cost ?? 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="page-title">{t('costCenters.title')}</h2>
          {totalCost > 0 && (
            <p className="text-sm text-muted mt-0.5">
              {t('costCenters.totalMtd', { amount: totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 }) })}
            </p>
          )}
        </div>
        <button
          onClick={() => openCreate()}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors"
        >
          {t('costCenters.newCostCenter')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('costCenters.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : costCenters.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('costCenters.empty')}
        </div>
      ) : (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden">
          {tree.map((node) => (
            <CostCenterRow
              key={node.id}
              node={node}
              depth={0}
              onEdit={openEdit}
              onDelete={(id) => deleteMutation.mutate(id)}
              onAddChild={(parentId) => openCreate(parentId)}
              isDeleting={deleteMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-xl p-6 w-full max-w-lg border border-edge shadow-xl">
            <h3 className="text-base font-semibold text-primary mb-4">
              {editingId ? t('costCenters.editTitle') : t('costCenters.newTitle')}
            </h3>
            {formError && (
              <div className="mb-3 p-2 rounded bg-danger/10 border border-danger/25 text-danger text-sm">
                {formError}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-secondary mb-1">{t('common.name')}</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                  placeholder={t('costCenters.namePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('costCenters.code')}</label>
                <input
                  value={form.code}
                  onChange={(e) =>
                    setForm({ ...form, code: e.target.value.toUpperCase().replace(/\s/g, '-') })
                  }
                  className={`${inputCls} font-mono`}
                  placeholder="ENG-PLATFORM"
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">
                  {t('costCenters.parentCostCenter')} <span className="text-muted">{t('costCenters.optional')}</span>
                </label>
                <select
                  value={form.parent_id}
                  onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
                  className={inputCls}
                >
                  <option value="">{t('costCenters.topLevel')}</option>
                  {costCenters
                    .filter((cc) => cc.id !== editingId)
                    .map((cc) => (
                      <option key={cc.id} value={cc.id}>
                        {cc.name} {cc.code ? `(${cc.code})` : ''}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('costCenters.owner')}</label>
                <input
                  value={form.owner}
                  onChange={(e) => setForm({ ...form, owner: e.target.value })}
                  className={inputCls}
                  placeholder={t('costCenters.ownerPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">
                  {t('common.description')} <span className="text-muted">{t('costCenters.optional')}</span>
                </label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className={`${inputCls} resize-none`}
                  placeholder={t('costCenters.descriptionPlaceholder')}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-secondary hover:text-primary border border-strong rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="px-5 py-2 bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-medium rounded-lg transition-colors"
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? t('costCenters.saving')
                    : editingId
                    ? t('costCenters.update')
                    : t('costCenters.createCostCenter')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Business capabilities (T17) */}
      <div className="bg-surface border border-edge rounded-xl overflow-hidden mt-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
          <div>
            <h3 className="text-sm font-semibold text-primary">{t('costCenters.capabilities')}</h3>
            <p className="text-xs text-muted mt-0.5">{t('costCenters.capabilitiesHint')}</p>
          </div>
          <button
            onClick={() => {
              setCapForm({ name: '', description: '', cost_center_id: '' })
              setCapError('')
              setShowCapModal(true)
            }}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-on-accent text-xs font-medium rounded-lg transition-colors"
            data-testid="add-capability"
          >
            {t('costCenters.addCapability')}
          </button>
        </div>
        {capabilities.length === 0 ? (
          <div className="px-5 py-6 text-center text-muted text-sm">{t('costCenters.noCapabilities')}</div>
        ) : (
          <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
            <thead className="border-b border-edge text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                <th className="px-4 py-3 font-medium">{t('costCenters.costCenter')}</th>
                <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.map((cap) => (
                <tr key={cap.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm text-primary">{cap.name}</p>
                    {cap.description && <p className="text-xs text-muted">{cap.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-secondary">
                    {cap.cost_center_name
                      ? `${cap.cost_center_code ? cap.cost_center_code + ' · ' : ''}${cap.cost_center_name}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => {
                        if (confirm(t('costCenters.deleteCapConfirm', { name: cap.name }))) {
                          deleteCapMutation.mutate(cap.id)
                        }
                      }}
                      className="text-danger hover:text-danger text-xs"
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Capability modal */}
      {showCapModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowCapModal(false)}
        >
          <div
            className="bg-surface border border-strong rounded-xl p-6 w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">{t('costCenters.newCapability')}</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!capForm.name.trim()) {
                  setCapError(t('costCenters.capNameRequired'))
                  return
                }
                createCapMutation.mutate()
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">{t('common.name')} *</label>
                <input
                  value={capForm.name}
                  onChange={(e) => setCapForm({ ...capForm, name: e.target.value })}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm"
                  placeholder="Platform Services"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">{t('common.description')}</label>
                <input
                  value={capForm.description}
                  onChange={(e) => setCapForm({ ...capForm, description: e.target.value })}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">{t('costCenters.costCenter')}</label>
                <select
                  value={capForm.cost_center_id}
                  onChange={(e) => setCapForm({ ...capForm, cost_center_id: e.target.value })}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm"
                >
                  <option value="">{t('costCenters.noCostCenter')}</option>
                  {costCenters.map((cc) => (
                    <option key={cc.id} value={cc.id}>{cc.code ? `${cc.code} · ${cc.name}` : cc.name}</option>
                  ))}
                </select>
              </div>
              {capError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">{capError}</div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCapModal(false)}
                  className="px-4 py-2 text-sm text-secondary hover:text-primary transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createCapMutation.isPending}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('costCenters.createCapability')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
