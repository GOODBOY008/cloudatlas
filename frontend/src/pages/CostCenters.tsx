import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState, type FormEvent } from 'react'
import { useMoneyFormatter } from '../lib/format'
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
  const fmt = useMoneyFormatter()
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

  const totalCost = costCenters
    .filter((cc) => !cc.parent_id)
    .reduce((s, cc) => s + (cc.current_cost ?? 0), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('costCenters.title')}</h1>
          {totalCost > 0 && (
            <p className="text-sm text-muted mt-0.5">
              {t('costCenters.totalMtd', { amount: fmt(totalCost) })}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          onClick={() => openCreate()}
        >
          {t('costCenters.newCostCenter')}
        </Button>
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
        <NativeDialog className="items-center justify-center p-4" label={editingId ? t('costCenters.editTitle') : t('costCenters.newTitle')} onClose={closeModal}>
          <div className="dialog-panel p-6 w-full max-w-lg">
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
                <Input label={t('common.name')}
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full"
                  placeholder={t('costCenters.namePlaceholder')}
                />
              </div>
              <div>
                <Input
                  label={t('costCenters.code')}
                  required={!editingId}
                  value={form.code}
                  onChange={e => setForm({ ...form, code: e.target.value.toUpperCase().replace(/\s/g, '-') })}
                  className="w-full font-mono"
                  placeholder="ENG-PLATFORM"
                />
              </div>
              <div>
                <SelectField
                  label={<>{t('costCenters.parentCostCenter')} <span className="text-muted">{t('costCenters.optional')}</span></>}
                  value={form.parent_id}
                  onValueChange={value => setForm({ ...form, parent_id: value })}
                  className="w-full"
                  items={[
                    { value: "", label: t('costCenters.topLevel') },
                    ...costCenters
                    .filter((cc) => cc.id !== editingId)
                    .map((cc) => ({ value: cc.id, label: `${cc.name} ${cc.code ? `(${cc.code})` : ''}` })),
                  ]}
                />
              </div>
              <div>
                <Input
                  label={t('costCenters.owner')}
                  value={form.owner}
                  onChange={(e) => setForm({ ...form, owner: e.target.value })}
                  className="w-full"
                  placeholder={t('costCenters.ownerPlaceholder')}
                />
              </div>
              <div>
                <InputArea label={<>{t('common.description')} <span className="text-muted">{t('costCenters.optional')}</span></>}
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full resize-y"
                  placeholder={t('costCenters.descriptionPlaceholder')}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  onClick={closeModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? t('costCenters.saving')
                    : editingId
                    ? t('costCenters.update')
                    : t('costCenters.createCostCenter')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}

      {/* Business capabilities (T17) */}
      <div className="bg-surface border border-edge rounded-xl overflow-hidden mt-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
          <div>
            <h3 className="text-sm font-semibold text-primary">{t('costCenters.capabilities')}</h3>
            <p className="text-xs text-muted mt-0.5">{t('costCenters.capabilitiesHint')}</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setCapForm({ name: '', description: '', cost_center_id: '' })
              setCapError('')
              setShowCapModal(true)
            }}
            data-testid="add-capability"
          >
            {t('costCenters.addCapability')}
          </Button>
        </div>
        {capabilities.length === 0 ? (
          <div className="px-5 py-6 text-center text-muted text-sm">{t('costCenters.noCapabilities')}</div>
        ) : (
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
            <Table.Header variant="compact" className="border-b border-edge">
              <Table.Row>
                <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('costCenters.costCenter')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {capabilities.map((cap) => (
                <Table.Row key={cap.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                  <Table.Cell className="px-4 py-3">
                    <p className="text-sm text-primary">{cap.name}</p>
                    {cap.description && <p className="text-xs text-muted">{cap.description}</p>}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-sm text-secondary">
                    {cap.cost_center_name
                      ? `${cap.cost_center_code ? cap.cost_center_code + ' · ' : ''}${cap.cost_center_name}`
                      : '—'}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <Button
                      size="sm" variant="secondary-destructive"
                      onClick={() => {
                        if (confirm(t('costCenters.deleteCapConfirm', { name: cap.name }))) {
                          deleteCapMutation.mutate(cap.id)
                        }
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        )}
      </div>

      {/* Capability modal */}
      {showCapModal && (
        <NativeDialog className="items-center justify-center p-4" label={t('costCenters.newCapability')} onClose={() => setShowCapModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-md"
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
                <Input
                  label={`${t('common.name')} *`}
                  value={capForm.name}
                  onChange={(e) => setCapForm({ ...capForm, name: e.target.value })}
                  className="w-full"
                  placeholder="Platform Services"
                />
              </div>
              <div>
                <Input
                  label={t('common.description')}
                  value={capForm.description}
                  onChange={(e) => setCapForm({ ...capForm, description: e.target.value })}
                  className="w-full"
                />
              </div>
              <div>
                <SelectField
                  label={t('costCenters.costCenter')}
                  value={capForm.cost_center_id}
                  onValueChange={value => setCapForm({ ...capForm, cost_center_id: value })}
                  className="w-full"
                  items={[
                    { value: "", label: t('costCenters.noCostCenter') },
                    ...costCenters.map((cc) => ({ value: cc.id, label: cc.code ? `${cc.code} · ${cc.name}` : cc.name })),
                  ]}
                />
              </div>
              {capError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">{capError}</div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowCapModal(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createCapMutation.isPending}
                >
                  {t('costCenters.createCapability')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
