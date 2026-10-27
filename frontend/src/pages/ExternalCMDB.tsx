import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ExternalCmdbConfig {
  id: string
  name: string
  provider: string
  is_active: boolean
  last_sync_at: string | null
  created_at: string
  ci_type_id?: string | null
  sync_direction?: string
}

interface SyncLog {
  id: string
  started_at: string
  completed_at: string | null
  status: string
  records_pulled: number
  records_pushed: number
  records_created: number
  records_updated: number
  records_failed: number
  error?: string | null
}

interface DryRunResult {
  would_create: number
  would_update: number
  unchanged: number
  failed: number
  samples: Array<{ external_id: string; name?: string; action: string }>
}

const PROVIDERS = ['rest', 'servicenow', 'jira']

interface ConfigForm {
  name: string
  provider: string
  config: string
}

const DEFAULT_FORM: ConfigForm = { name: '', provider: 'rest', config: '' }

function configTemplate(provider: string): string {
  if (provider === 'servicenow') {
    return JSON.stringify(
      {
        base_url: 'https://instance.service-now.com',
        ci_type_id: '',
        sync_direction: 'pull',
        auth_config: { auth_type: 'basic', username: 'user', password: 'pass' },
        field_mapping: { external_id: 'sys_id', name: 'name', meta: { environment: 'environment' } },
        options: { table: 'cmdb_ci_linux' },
      },
      null,
      2,
    )
  }
  return JSON.stringify(
    {
      base_url: 'https://cmdb.example.com',
      ci_type_id: '',
      sync_direction: 'pull',
      auth_config: { auth_type: 'header', header_name: 'X-API-Key', token: 'key' },
      field_mapping: { external_id: 'id', name: 'name', meta: { environment: 'env' } },
      options: { list_path: 'api/v1/cis', push_path: 'api/v1/cis' },
    },
    null,
    2,
  )
}

export default function ExternalCMDB() {
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<ConfigForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null)

  const { data: configs = [], isLoading, isError } = useQuery<ExternalCmdbConfig[]>({
    queryKey: ['external-cmdb', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ExternalCmdbConfig[] }>(`/orgs/${orgId}/external-cmdb`)
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<Array<{ id: string; display_name: string }>>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId && showModal,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; display_name: string }> }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  // Sync logs for the selected config (T13).
  const { query: logsQuery, rows: logs, page, perPage, totalPages, total, setPage, setPerPage } =
    usePagination<SyncLog>(
      ['external-cmdb-logs', orgId, selectedId],
      (p, pp) =>
        paginatedGet<SyncLog>(`/orgs/${orgId}/external-cmdb/${selectedId}/logs`, {
          page: p,
          per_page: pp,
        }),
      { defaultPerPage: 10, enabled: !!orgId && !!selectedId },
    )
  const logsLoading = logsQuery.isLoading

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; provider: string; config: unknown }) =>
      api.post(`/orgs/${orgId}/external-cmdb`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['external-cmdb', orgId] })
      setShowModal(false)
      setForm(DEFAULT_FORM)
      setFormError('')
    },
    onError: () => setFormError(t('externalCmdb.createFailed')),
  })

  const syncMutation = useMutation({
    mutationFn: (configId: string) => api.post(`/orgs/${orgId}/external-cmdb/${configId}/sync`, {}),
    onSuccess: () => {
      setMessage(t('externalCmdb.syncStarted'))
      queryClient.invalidateQueries({ queryKey: ['external-cmdb', orgId] })
      if (selectedId) queryClient.invalidateQueries({ queryKey: ['external-cmdb-logs', orgId, selectedId] })
    },
    onError: (err: any) => setMessage(err?.response?.data?.error?.message ?? t('externalCmdb.syncFailed')),
  })

  const dryRunMutation = useMutation({
    mutationFn: (configId: string) =>
      api.get<{ data: DryRunResult }>(`/orgs/${orgId}/external-cmdb/${configId}/dry-run`).then((r) => r.data.data),
    onSuccess: (data) => {
      setDryRun(data)
      setMessage('')
    },
    onError: (err: any) => setMessage(err?.response?.data?.error?.message ?? t('externalCmdb.dryRunFailed')),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.name.trim()) {
      setFormError(t('externalCmdb.nameRequired'))
      return
    }
    let config: unknown
    try {
      config = JSON.parse(form.config || configTemplate(form.provider))
    } catch {
      setFormError(t('externalCmdb.configInvalidJson'))
      return
    }
    createMutation.mutate({ name: form.name.trim(), provider: form.provider, config })
  }

  const inputCls =
    'bg-subtle border border-strong rounded-lg px-3 py-2 text-primary text-sm w-full focus:outline-none focus:ring-2 focus:ring-accent'

  const selected = configs.find((c) => c.id === selectedId) ?? null

  function selectedCiTypeId(): string {
    try {
      return (JSON.parse(form.config || '{}') as { ci_type_id?: string }).ci_type_id ?? ''
    } catch {
      return ''
    }
  }

  function setConfigCiTypeId(id: string) {
    try {
      const cfg = JSON.parse(form.config || '{}')
      cfg.ci_type_id = id
      setForm({ ...form, config: JSON.stringify(cfg, null, 2) })
    } catch {
      /* template not valid JSON — leave as-is */
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="page-title">{t('externalCmdb.title')}</h2>
        <button
          onClick={() => {
            setForm({ name: '', provider: 'rest', config: configTemplate('rest') })
            setFormError('')
            setShowModal(true)
          }}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors"
        >
          {t('externalCmdb.newConnection')}
        </button>
      </div>

      {message && (
        <div className="mb-4 p-3 rounded-lg bg-info/10 border border-info/25 text-info text-sm">
          {message}
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('externalCmdb.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : configs.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('externalCmdb.empty')}
        </div>
      ) : (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden mb-6">
          <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
            <thead className="border-b border-edge text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                <th className="px-4 py-3 font-medium">{t('cmdb.provider')}</th>
                <th className="px-4 py-3 font-medium">{t('externalCmdb.direction')}</th>
                <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                <th className="px-4 py-3 font-medium">{t('cloudAccounts.lastSync')}</th>
                <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr
                  key={c.id}
                  className={`border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors cursor-pointer ${
                    selectedId === c.id ? 'bg-accent-soft/20' : ''
                  }`}
                  onClick={() => {
                    setSelectedId(c.id)
                    setDryRun(null)
                    setMessage('')
                  }}
                >
                  <td className="px-4 py-3 text-sm text-primary">{c.name}</td>
                  <td className="px-4 py-3 text-sm text-secondary">{c.provider}</td>
                  <td className="px-4 py-3 text-xs text-secondary">{c.sync_direction ?? 'pull'}</td>
                  <td className="px-4 py-3">
                    {c.is_active ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                        {t('common.active')}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-subtle text-secondary">
                        {t('common.inactive')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : t('common.never')}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => dryRunMutation.mutate(c.id)}
                      disabled={dryRunMutation.isPending}
                      className="text-xs text-accent hover:text-accent disabled:opacity-50 mr-3"
                      data-testid={`extcmdb-dryrun-${c.name}`}
                    >
                      {t('externalCmdb.dryRun')}
                    </button>
                    <button
                      onClick={() => syncMutation.mutate(c.id)}
                      disabled={syncMutation.isPending}
                      className="text-xs text-success hover:text-success disabled:opacity-50"
                    >
                      {t('externalCmdb.syncNow')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {/* Dry-run preview (T13) */}
      {dryRun && (
        <div className="bg-surface border border-edge rounded-xl p-4 mb-6 space-y-2" data-testid="extcmdb-dryrun-result">
          <h3 className="text-sm font-semibold text-primary">{t('externalCmdb.dryRunTitle')}</h3>
          <div className="flex gap-6 text-sm">
            <span className="text-success">+{dryRun.would_create} {t('externalCmdb.wouldCreate')}</span>
            <span className="text-warning">~{dryRun.would_update} {t('externalCmdb.wouldUpdate')}</span>
            <span className="text-muted">= {dryRun.unchanged} {t('externalCmdb.unchanged')}</span>
            {dryRun.failed > 0 && <span className="text-danger">✗{dryRun.failed}</span>}
          </div>
          {dryRun.samples.length > 0 && (
            <div className="text-xs text-secondary space-y-1">
              {dryRun.samples.slice(0, 5).map((s, i) => (
                <p key={i}>
                  <span className={s.action === 'create' ? 'text-success' : 'text-warning'}>{s.action}</span>{' '}
                  {s.name ?? s.external_id} <span className="text-muted">({s.external_id})</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sync logs (T13) */}
      {selected && (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-edge">
            <h3 className="text-sm font-semibold text-primary">
              {t('externalCmdb.syncHistory')} — {selected.name}
            </h3>
          </div>
          {logsLoading ? (
            <div className="p-5 text-muted text-sm">{t('common.loading')}</div>
          ) : logs.length === 0 ? (
            <div className="p-5 text-center text-muted text-sm">{t('externalCmdb.noSyncs')}</div>
          ) : (
            <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
              <thead className="border-b border-edge text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('externalCmdb.startedAt')}</th>
                  <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                  <th className="px-4 py-3 font-medium">{t('externalCmdb.createdCol')}</th>
                  <th className="px-4 py-3 font-medium">{t('externalCmdb.updatedCol')}</th>
                  <th className="px-4 py-3 font-medium">{t('externalCmdb.pushedCol')}</th>
                  <th className="px-4 py-3 font-medium">{t('externalCmdb.failedCol')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                    <td className="px-4 py-3 text-xs text-secondary">
                      {new Date(l.started_at).toLocaleString()}
                      {l.error && <span className="block text-danger text-xs mt-0.5">{l.error}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          l.status === 'success'
                            ? 'bg-success/10 text-success'
                            : l.status === 'failed'
                              ? 'bg-danger/10 text-danger'
                              : 'bg-warning/10 text-warning'
                        }`}
                      >
                        {l.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-success">+{l.records_created}</td>
                    <td className="px-4 py-3 text-sm text-warning">~{l.records_updated}</td>
                    <td className="px-4 py-3 text-sm text-info">↑{l.records_pushed}</td>
                    <td className="px-4 py-3 text-sm text-danger">{l.records_failed}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
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
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-surface border border-strong rounded-xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">{t('externalCmdb.newConnectionTitle')}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-secondary mb-1">{t('common.name')}</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputCls}
                    placeholder="prod-cmdb"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-secondary mb-1">{t('cmdb.provider')}</label>
                  <select
                    value={form.provider}
                    onChange={(e) =>
                      setForm({ ...form, provider: e.target.value, config: configTemplate(e.target.value) })
                    }
                    className={inputCls}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">{t('externalCmdb.ciTypeHint')}</label>
                <select
                  value={selectedCiTypeId()}
                  onChange={(e) => setConfigCiTypeId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">{t('externalCmdb.selectCiType')}</option>
                  {ciTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.display_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">
                  {t('externalCmdb.configLabel')}
                </label>
                <textarea
                  value={form.config}
                  onChange={(e) => setForm({ ...form, config: e.target.value })}
                  rows={10}
                  className={`${inputCls} font-mono text-xs`}
                />
              </div>
              {formError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-secondary hover:text-primary transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('externalCmdb.createConnection')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
