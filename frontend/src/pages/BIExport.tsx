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

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('biExport.title')}</h2>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('biExport.newExport')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('biExport.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : exports.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('biExport.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {exports.map((e) => (
            <div key={e.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="font-medium text-white">{e.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {t(`biExport.scope.${e.scope}`, { defaultValue: e.scope })} · {e.format.toUpperCase()}
                      {typeof e.filters?.start_date === 'string' && ` · ${e.filters.start_date} → ${e.filters.end_date ?? t('biExport.now')}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-gray-500">{t('biExport.runsCount', { count: e.run_count })}</span>
                  {e.last_run_at && (
                    <span className="text-gray-500">{t('biExport.lastRun', { date: new Date(e.last_run_at).toLocaleDateString() })}</span>
                  )}
                  <button
                    onClick={() => runMutation.mutate(e.id)}
                    disabled={runMutation.isPending}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg disabled:opacity-50"
                  >
                    {t('biExport.run')}
                  </button>
                  <button
                    onClick={() => download(e.id)}
                    className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg"
                  >
                    {t('biExport.download')}
                  </button>
                  <button onClick={() => openEdit(e)} className="text-indigo-400 hover:text-indigo-300">
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('biExport.confirmDelete', { name: e.name }))) deleteMutation.mutate(e.id)
                    }}
                    className="text-red-400 hover:text-red-300"
                  >
                    {t('common.delete')}
                  </button>
                  <button
                    onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                    className="text-gray-400 hover:text-gray-200"
                  >
                    {expandedId === e.id ? t('biExport.hideRuns') : t('biExport.showRuns')}
                  </button>
                </div>
              </div>
              {expandedId === e.id && (
                <div className="border-t border-gray-800">
                  {runsLoading ? (
                    <div className="p-4 text-gray-500 text-xs">{t('common.loading')}</div>
                  ) : runs.length === 0 ? (
                    <div className="p-4 text-gray-500 text-xs">{t('biExport.noRuns')}</div>
                  ) : (
                    <table className="w-full text-left">
                      <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                        <tr>
                          <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                          <th className="px-4 py-2 font-medium">{t('biExport.colRows')}</th>
                          <th className="px-4 py-2 font-medium">{t('biExport.colError')}</th>
                          <th className="px-4 py-2 font-medium">{t('common.created')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.id} className="border-b border-gray-700 last:border-0">
                            <td className="px-4 py-2 text-xs">
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  r.status === 'completed'
                                    ? 'bg-green-900/40 text-green-300'
                                    : 'bg-red-900/40 text-red-300'
                                }`}
                              >
                                {t(`status.${r.status}`, { defaultValue: r.status })}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-xs text-gray-300">{r.row_count.toLocaleString()}</td>
                            <td className="px-4 py-2 text-xs text-gray-500">{r.error_message ?? '—'}</td>
                            <td className="px-4 py-2 text-xs text-gray-500">
                              {new Date(r.created_at).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? t('biExport.editExport') : t('biExport.newExportTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                  placeholder={t('biExport.namePlaceholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('biExport.format')}</label>
                  <select
                    value={form.format}
                    onChange={(e) => setForm({ ...form, format: e.target.value as 'csv' | 'json' })}
                    className={inputCls}
                  >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('biExport.scope')}</label>
                  <select
                    value={form.scope}
                    onChange={(e) =>
                      setForm({ ...form, scope: e.target.value as ExportForm['scope'] })
                    }
                    className={inputCls}
                  >
                    {SCOPES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {t(s.labelKey)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {form.scope === 'expenses' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">{t('biExport.startDate')}</label>
                    <input
                      type="date"
                      value={form.start_date}
                      onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">{t('biExport.endDate')}</label>
                    <input
                      type="date"
                      value={form.end_date}
                      onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                </div>
              )}
              {formError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {editingId ? t('biExport.saveChanges') : t('biExport.createExport')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
