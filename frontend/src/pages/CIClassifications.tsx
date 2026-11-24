import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Classification {
  id: string
  organization_id: string | null
  name: string
  display_name: string
  description?: string
  icon?: string
  sort_order: number
  is_builtin: boolean
  ci_type_count: number
  created_at: string
  updated_at: string
}

const ICONS = ['📦', '🖥', '🌐', '🗄', '🔧', '🛡', '📡', '🧩', '⚙', '🏗', '☁', '🔌']

export default function CIClassifications() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('')
  const [sortOrder, setSortOrder] = useState(0)

  const { data: classifications = [], isLoading } = useQuery<Classification[]>({
    queryKey: ['ci-classifications', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Classification[] }>(
        `/orgs/${orgId}/ci-classifications`
      )
      return res.data ?? []
    },
  })

  function resetForm() {
    setName('')
    setDisplayName('')
    setDescription('')
    setIcon('')
    setSortOrder(0)
    setEditingId(null)
    setFormError('')
    setShowForm(false)
  }

  function startEdit(c: Classification) {
    setName(c.name)
    setDisplayName(c.display_name)
    setDescription(c.description ?? '')
    setIcon(c.icon ?? '')
    setSortOrder(c.sort_order)
    setEditingId(c.id)
    setShowForm(true)
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/ci-classifications`, {
        name: name.trim(),
        display_name: displayName.trim(),
        description: description.trim() || undefined,
        icon: icon || undefined,
        sort_order: sortOrder,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-classifications', orgId] })
      resetForm()
    },
    onError: () => setFormError(t('ciClassifications.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: () =>
      api.put(`/orgs/${orgId}/ci-classifications/${editingId}`, {
        display_name: displayName.trim(),
        description: description.trim() || undefined,
        icon: icon || undefined,
        sort_order: sortOrder,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-classifications', orgId] })
      resetForm()
    },
    onError: () => setFormError(t('ciClassifications.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/orgs/${orgId}/ci-classifications/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['ci-classifications', orgId] }),
  })

  const busy = createMutation.isPending || updateMutation.isPending

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('ciClassifications.title')}</h1>
          <p className="text-sm text-secondary mt-0.5">
            {t('ciClassifications.subtitle')}
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => { resetForm(); setShowForm(true) }}
        >
          {t('ciClassifications.newClassification')}
        </Button>
      </div>

      {/* Create / Edit Form */}
      {showForm && (
        <div className="bg-subtle rounded-xl border border-strong p-5 space-y-4">
          <h2 className="text-base font-semibold text-primary">
            {editingId ? t('ciClassifications.editTitle') : t('ciClassifications.newTitle')}
          </h2>
          {formError && (
            <p className="text-danger text-sm">{formError}</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Input
                label={t('ciClassifications.nameKey')}
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={!!editingId}
                placeholder={t('ciClassifications.namePlaceholder')}
                className="w-full"
              />
            </div>
            <div>
              <Input
                label={t('cmdb.displayName')}
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('ciClassifications.displayPlaceholder')}
                className="w-full"
              />
            </div>
          </div>
          <div>
            <Input
              label={t('common.description')}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('ciClassifications.optionalDesc')}
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-secondary mb-1">{t('ciClassifications.icon')}</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {ICONS.map(ic => (
                  <button
                    key={ic}
                    onClick={() => setIcon(ic)}
                    className={`text-xl p-1 rounded border ${icon === ic ? 'border-accent bg-accent-soft/30' : 'border-strong hover:border-strong'}`}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Input
                label={t('ciClassifications.sortOrder')}
                type="number"
                value={sortOrder}
                onChange={e => setSortOrder(Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <Button
              variant="primary"
              disabled={busy || !name.trim() || !displayName.trim()}
              onClick={() => editingId ? updateMutation.mutate() : createMutation.mutate()}
            >
              {busy ? t('ciClassifications.saving') : editingId ? t('ciClassifications.update') : t('ciClassifications.create')}
            </Button>
            <Button
              onClick={resetForm}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <p className="text-muted text-sm">{t('ciClassifications.loading')}</p>
      ) : classifications.length === 0 ? (
        <div className="text-center py-16 text-muted">
          <p className="text-4xl mb-3">📂</p>
          <p className="text-sm">{t('ciClassifications.empty')}</p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-edge overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact">
              <Table.Row className="text-xs text-muted border-b border-edge">
                <Table.Head className="text-left px-4 py-3 font-medium">{t('ciClassifications.icon')}</Table.Head>
                <Table.Head className="text-left px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                <Table.Head className="text-left px-4 py-3 font-medium">{t('cmdb.displayName')}</Table.Head>
                <Table.Head className="text-left px-4 py-3 font-medium">{t('common.description')}</Table.Head>
                <Table.Head className="text-right px-4 py-3 font-medium">{t('ciClassifications.colCiTypes')}</Table.Head>
                <Table.Head className="text-right px-4 py-3 font-medium">{t('ciClassifications.colOrder')}</Table.Head>
                <Table.Head className="text-right px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {classifications.map(c => (
                <Table.Row key={c.id} className="border-b border-edge/60 hover:bg-subtle/30">
                  <Table.Cell className="px-4 py-3 text-xl">{c.icon ?? '📂'}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-primary font-mono text-xs">
                    {c.name}
                    {c.is_builtin && (
                      <span className="ml-2 px-1.5 py-0.5 bg-emphasis text-secondary text-xs rounded">
                        {t('ciClassifications.builtin')}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-primary">{c.display_name}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary truncate max-w-[200px]">
                    {c.description ?? '—'}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-right">
                    <span className="text-accent font-medium">{c.ci_type_count}</span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-right text-muted">{c.sort_order}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-right">
                    {!c.is_builtin && (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => startEdit(c)}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          size="sm" variant="secondary-destructive"
                          onClick={() => {
                            if (confirm(t('ciClassifications.deleteConfirm', { name: c.display_name })))
                              deleteMutation.mutate(c.id)
                          }}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}
    </div>
  )
}
