import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ExportDef {
  id: string
  name: string
  format: 'csv' | 'json'
  scope: 'expenses' | 'recommendations' | 'resources'
  filters: Record<string, unknown>
  run_count: number
  last_run_at: string | null
  created_at: string
}

interface ExportRun {
  id: string
  export_id: string
  status: string
  row_count: number
  error_message: string | null
  created_at: string
}

interface ExportForm {
  name: string
  format: 'csv' | 'json'
  scope: 'expenses' | 'recommendations' | 'resources'
  start_date: string
  end_date: string
}

const DEFAULT_FORM: ExportForm = {
  name: '',
  format: 'csv',
  scope: 'expenses',
  start_date: '',
  end_date: '',
}

const SCOPES: { value: ExportForm['scope']; labelKey: string }[] = [
  { value: 'expenses', labelKey: 'biExport.scope.expenses' },
  { value: 'recommendations', labelKey: 'biExport.scope.recommendations' },
  { value: 'resources', labelKey: 'biExport.scope.resources' },
]

export default function BIExport() {
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ExportForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: exports = [], isLoading, isError } = useQuery<ExportDef[]>({
    queryKey: ['bi-exports', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ExportDef[] }>(`/orgs/${orgId}/bi-exports`)
      return res.data ?? []
    },
  })

  const { data: runs = [], isLoading: runsLoading } = useQuery<ExportRun[]>({
    queryKey: ['bi-export-runs', orgId, expandedId],
    enabled: !!orgId && !!expandedId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ExportRun[] }>(
        `/orgs/${orgId}/bi-exports/${expandedId}/runs`
      )
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post(`/orgs/${orgId}/bi-exports`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bi-exports', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('biExport.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/bi-exports/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bi-exports', orgId] }),
  })

  const runMutation = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgId}/bi-exports/${id}/run`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bi-exports', orgId] })
      queryClient.invalidateQueries({ queryKey: ['bi-export-runs', orgId, expandedId] })
    },
  })

  function openCreate() {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setShowModal(true)
  }

  function openEdit(e: ExportDef) {
    setEditingId(e.id)
    const filters = e.filters ?? {}
    setForm({
      name: e.name,
      format: e.format,
      scope: e.scope,
      start_date: typeof filters.start_date === 'string' ? filters.start_date : '',
      end_date: typeof filters.end_date === 'string' ? filters.end_date : '',
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
    if (!form.name.trim()) {
      setFormError(t('biExport.nameRequired'))
      return
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      format: form.format,
      scope: form.scope,
    }
    const filters: Record<string, string> = {}
    if (form.start_date) filters.start_date = form.start_date
    if (form.end_date) filters.end_date = form.end_date
    if (Object.keys(filters).length > 0) payload.filters = filters

    if (editingId) {
      api.put(`/orgs/${orgId}/bi-exports/${editingId}`, payload).then(() => {
        queryClient.invalidateQueries({ queryKey: ['bi-exports', orgId] })
        closeModal()
      }).catch(() => setFormError(t('biExport.updateFailed')))
    } else {
      createMutation.mutate(payload)
    }
  }

  async function download(id: string) {
    try {
      // Blob download so the Bearer token header is attached (window.open cannot).
      const res = await api.get(`/orgs/${orgId}/bi-exports/${id}/download`, {
        responseType: 'blob',
      })
      const disposition: string = (res.headers['content-disposition'] as string) ?? ''
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match ? match[1] : 'export.csv'
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setFormError(t('biExport.downloadFailed'))
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('biExport.title')}</h1>
        <Button
          variant="primary"
          onClick={openCreate}
        >
          {t('biExport.newExport')}
        </Button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('biExport.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : exports.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('biExport.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {exports.map((e) => (
            <div key={e.id} className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div className="flex flex-col gap-3 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="font-medium text-primary">{e.name}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {t(`biExport.scope.${e.scope}`, { defaultValue: e.scope })} · {e.format.toUpperCase()}
                      {typeof e.filters?.start_date === 'string' && ` · ${e.filters.start_date} → ${e.filters.end_date ?? t('biExport.now')}`}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                  <span className="text-muted">{t('biExport.runsCount', { count: e.run_count })}</span>
                  {e.last_run_at && (
                    <span className="text-muted">{t('biExport.lastRun', { date: new Date(e.last_run_at).toLocaleDateString() })}</span>
                  )}
                  <Button
                    variant="primary"
                    onClick={() => runMutation.mutate(e.id)}
                    disabled={runMutation.isPending}
                  >
                    {t('biExport.run')}
                  </Button>
                  <Button
                    onClick={() => download(e.id)}
                  >
                    {t('biExport.download')}
                  </Button>
                  <button onClick={() => openEdit(e)} className="text-accent hover:text-accent">
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('biExport.confirmDelete', { name: e.name }))) deleteMutation.mutate(e.id)
                    }}
                    className="text-danger hover:text-danger"
                  >
                    {t('common.delete')}
                  </button>
                  <button
                    onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                    className="text-secondary hover:text-primary"
                  >
                    {expandedId === e.id ? t('biExport.hideRuns') : t('biExport.showRuns')}
                  </button>
                </div>
              </div>
              {expandedId === e.id && (
                <div className="border-t border-edge">
                  {runsLoading ? (
                    <div className="p-4 text-muted text-xs">{t('common.loading')}</div>
                  ) : runs.length === 0 ? (
                    <div className="p-4 text-muted text-xs">{t('biExport.noRuns')}</div>
                  ) : (
                    <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                      <Table.Header variant="compact" className="border-b border-edge">
                        <Table.Row>
                          <Table.Head className="px-4 py-2 font-medium">{t('common.status')}</Table.Head>
                          <Table.Head className="px-4 py-2 font-medium">{t('biExport.colRows')}</Table.Head>
                          <Table.Head className="px-4 py-2 font-medium">{t('biExport.colError')}</Table.Head>
                          <Table.Head className="px-4 py-2 font-medium">{t('common.created')}</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {runs.map((r) => (
                          <Table.Row key={r.id} className="border-b border-strong last:border-0">
                            <Table.Cell className="px-4 py-2 text-xs">
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  r.status === 'completed'
                                    ? 'bg-success/10 text-success'
                                    : 'bg-danger/10 text-danger'
                                }`}
                              >
                                {t(`status.${r.status}`, { defaultValue: r.status })}
                              </span>
                            </Table.Cell>
                            <Table.Cell className="px-4 py-2 text-xs text-secondary">{r.row_count.toLocaleString()}</Table.Cell>
                            <Table.Cell className="px-4 py-2 text-xs text-muted">{r.error_message ?? '—'}</Table.Cell>
                            <Table.Cell className="px-4 py-2 text-xs text-muted">
                              {new Date(r.created_at).toLocaleString()}
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table></div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={editingId ? t('biExport.editExport') : t('biExport.newExportTitle')} onClose={closeModal}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">
              {editingId ? t('biExport.editExport') : t('biExport.newExportTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input
                  label={t('common.name')}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full"
                  placeholder={t('biExport.namePlaceholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <SelectField
                    label={t('biExport.format')}
                    value={form.format}
                    onValueChange={value => setForm({ ...form, format: value as 'csv' | 'json' })}
                    className="w-full"
                    items={[
                      { value: "csv", label: "CSV" },
                      { value: "json", label: "JSON" },
                    ]}
                  />
                </div>
                <div>
                  <SelectField
                    label={t('biExport.scope')}
                    value={form.scope}
                    onValueChange={value =>
                      setForm({ ...form, scope: value as ExportForm['scope'] })}
                    className="w-full"
                    items={SCOPES.map((s) => ({ value: s.value, label: t(s.labelKey) }))}
                  />
                </div>
              </div>
              {form.scope === 'expenses' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Input
                      label={t('biExport.startDate')}
                      type="date"
                      value={form.start_date}
                      onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Input
                      label={t('biExport.endDate')}
                      type="date"
                      value={form.end_date}
                      onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                      className="w-full"
                    />
                  </div>
                </div>
              )}
              {formError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={closeModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending}
                >
                  {editingId ? t('biExport.saveChanges') : t('biExport.createExport')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
