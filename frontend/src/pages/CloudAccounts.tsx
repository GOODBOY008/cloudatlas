import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useActiveJobs } from '../lib/hooks/useJobs'
import { Modal } from '../components/shared/Modal'
import { ProviderBadge } from '../components/shared/ProviderBadge'
import { CLOUD_PROVIDERS, providerLabel } from '../lib/providers'
import type { CloudAccount } from '../types'

interface NewAccountForm {
  name: string
  provider: string
  external_id: string
  credentials: Record<string, string>
  config: Record<string, string>
}

// Per-provider credential fields, keyed by the backend `credentials` JSON key.
// `required: false` fields are optional (tokens). Labels are i18n keys.
const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; secret?: boolean; required?: boolean }[]> = {
  aws: [
    { key: 'access_key_id', label: 'cloudAccounts.credAwsAccessKey' },
    { key: 'secret_access_key', label: 'cloudAccounts.credAwsSecret', secret: true },
    { key: 'session_token', label: 'cloudAccounts.credAwsToken', secret: true, required: false },
  ],
  alibaba: [
    { key: 'access_key_id', label: 'cloudAccounts.credAliyunAccessKey' },
    { key: 'access_key_secret', label: 'cloudAccounts.credAliyunSecret', secret: true },
    { key: 'security_token', label: 'cloudAccounts.credAliyunToken', secret: true, required: false },
  ],
  azure: [
    { key: 'client_id', label: 'cloudAccounts.credAzureClientId' },
    { key: 'client_secret', label: 'cloudAccounts.credAzureClientSecret', secret: true },
    { key: 'tenant_id', label: 'cloudAccounts.credAzureTenantId' },
    { key: 'subscription_id', label: 'cloudAccounts.credAzureSubscriptionId' },
  ],
  gcp: [
    { key: 'access_token', label: 'cloudAccounts.credGcpAccessToken', secret: true },
    { key: 'project_id', label: 'cloudAccounts.credGcpProjectId' },
  ],
  kubernetes: [
    { key: 'server', label: 'cloudAccounts.credK8sServer' },
    { key: 'token', label: 'cloudAccounts.credK8sToken', secret: true },
  ],
}

// Optional per-provider `config` fields shown next to the credential fields.
// `type: 'number'` values are sent as JSON numbers (e.g. k8s cost rates).
// `regions` is sent as an array split on commas.
const CONFIG_FIELDS: Record<string, { key: string; label: string; placeholder?: string; type?: string }[]> = {
  alibaba: [
    { key: 'region_id', label: 'cloudAccounts.cfgAliyunRegionId', placeholder: 'cn-hangzhou' },
    { key: 'regions', label: 'cloudAccounts.cfgAliyunRegions', placeholder: 'cn-hangzhou,cn-hongkong' },
  ],
  kubernetes: [
    { key: 'namespace', label: 'cloudAccounts.cfgK8sNamespace', placeholder: 'all namespaces' },
    { key: 'cluster_name', label: 'cloudAccounts.cfgK8sClusterName', placeholder: 'API server host' },
    { key: 'cpu_hourly_cost', label: 'cloudAccounts.cfgK8sCpuCost', placeholder: '0.04', type: 'number' },
    { key: 'memory_hourly_cost', label: 'cloudAccounts.cfgK8sMemCost', placeholder: '0.005', type: 'number' },
  ],
}

// Turn a stored account `config` object back into editable string fields
// (arrays like `regions` become CSV for the input).
function prefillConfig(cfg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (Array.isArray(v)) out[k] = v.join(', ')
    else if (typeof v === 'string' || typeof v === 'number') out[k] = String(v)
  }
  return out
}

export default function CloudAccounts() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<NewAccountForm>({ name: '', provider: 'aws', external_id: '', credentials: {}, config: {} })
  const [formError, setFormError] = useState('')
  const [editAcct, setEditAcct] = useState<CloudAccount | null>(null)
  const [editName, setEditName] = useState('')
  const [editCurrency, setEditCurrency] = useState('USD')
  const [editCreds, setEditCreds] = useState<Record<string, string>>({})
  const [editConfig, setEditConfig] = useState<Record<string, string>>({})
  const [editClear, setEditClear] = useState(false)
  const [deleteAcct, setDeleteAcct] = useState<CloudAccount | null>(null)
  const [alertMsg, setAlertMsg] = useState<string | null>(null)

  const { data = [], isLoading, isError } = useQuery<CloudAccount[]>({
    queryKey: ['cloud-accounts', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CloudAccount[] }>(`/orgs/${orgId}/cloud-accounts`)
      return res.data ?? []
    },
  })

  // Inline per-account job chips, derived from the shared active-jobs poll —
  // no per-row polling query (spec §5.3). On terminal transition the hook
  // invalidates ['cloud-accounts'], replacing the old blind 4 s re-fetch.
  const { data: activeJobs = [] } = useActiveJobs(orgId)
  const activeJobFor = (id: string, kind: string) =>
    activeJobs.find((j) => j.cloud_account_id === id && j.job_kind === kind)
  const syncDisabled = (id: string) => !!activeJobFor(id, 'discovery')

  const addMutation = useMutation({
    mutationFn: (payload: NewAccountForm) => {
      const creds = Object.fromEntries(
        Object.entries(payload.credentials).filter(([, v]) => v.trim() !== ''),
      )
      const config: Record<string, unknown> = { external_id: payload.external_id || null }
      for (const f of CONFIG_FIELDS[payload.provider] ?? []) {
        const v = payload.config[f.key]?.trim()
        if (v) {
          config[f.key] = f.key === 'regions'
            ? v.split(',').map((s) => s.trim()).filter(Boolean)
            : (f.type === 'number' ? Number(v) : v)
        }
      }
      return api.post(`/orgs/${orgId}/cloud-accounts`, {
        name: payload.name,
        provider: payload.provider,
        credentials: Object.keys(creds).length > 0 ? creds : {},
        config,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloud-accounts', orgId] })
      setForm({ name: '', provider: 'aws', external_id: '', credentials: {}, config: {} })
      setShowForm(false)
      setFormError('')
    },
    onError: () => setFormError(t('cloudAccounts.addFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, name, currency, credentials, config }: {
      id: string; name: string; currency: string; credentials: Record<string, string>; config?: Record<string, unknown>
    }) => {
      const body: Record<string, unknown> = { name, currency }
      const creds = Object.fromEntries(
        Object.entries(credentials).filter(([, v]) => v.trim() !== ''),
      )
      if (Object.keys(creds).length > 0) body.credentials = creds
      if (config && Object.keys(config).length > 0) body.config = config
      return api.put(`/orgs/${orgId}/cloud-accounts/${id}`, body)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cloud-accounts', orgId] }),
  })

  const clearMutation = useMutation({
    mutationFn: (id: string) => api.put(`/orgs/${orgId}/cloud-accounts/${id}`, { credentials: '__CLEAR__' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloud-accounts', orgId] })
      setEditAcct(null)
      setEditClear(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/cloud-accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cloud-accounts', orgId] }),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgId}/cloud-accounts/${id}/test`),
  })

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgId}/cloud-accounts/${id}/sync`),
    onSuccess: () => {
      // 202 + job handle — the active-jobs poll drives the chip lifecycle and
      // the terminal-transition invalidation refreshes this table.
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (err) => {
      const axiosErr = err as { response?: { status?: number; data?: { error?: { message?: string } } } }
      if (axiosErr.response?.status === 409) {
        setAlertMsg(t('jobs.conflictBody'))
      } else {
        setAlertMsg(axiosErr.response?.data?.error?.message ?? t('cloudAccounts.syncFailed'))
      }
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const fields = CREDENTIAL_FIELDS[form.provider] ?? []
    const missing = fields.some((f) => f.required !== false && !form.credentials[f.key]?.trim())
    if (missing) {
      setFormError(t('cloudAccounts.credRequired'))
      return
    }
    setFormError('')
    addMutation.mutate(form)
  }

  return (
    <>
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('cloudAccounts.title')}</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {showForm ? t('common.cancel') : t('cloudAccounts.addAccount')}
        </button>
      </div>

      {/* Add account form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-200 mb-4">{t('cloudAccounts.newAccount')}</h3>
          {formError && (
            <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">{formError}</div>
          )}
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="account-name" className="block text-xs text-gray-400 mb-1">{t('cloudAccounts.accountName')}</label>
              <input
                id="account-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={t('cloudAccounts.namePlaceholder')}
              />
            </div>
            <div>
              <label htmlFor="provider" className="block text-xs text-gray-400 mb-1">{t('cloudAccounts.provider')}</label>
              <select
                id="provider"
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {CLOUD_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{providerLabel(p)}</option>
                ))}
              </select>
            </div>
            {(CREDENTIAL_FIELDS[form.provider] ?? []).map((f) => (
              <div key={f.key}>
                <label htmlFor={`cred-${f.key}`} className="block text-xs text-gray-400 mb-1">
                  {t(f.label)}
                </label>
                <input
                  id={`cred-${f.key}`}
                  type={f.secret ? 'password' : 'text'}
                  value={form.credentials[f.key] ?? ''}
                  onChange={(e) => setForm({ ...form, credentials: { ...form.credentials, [f.key]: e.target.value } })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            ))}
            {(CONFIG_FIELDS[form.provider] ?? []).map((f) => (
              <div key={f.key}>
                <label htmlFor={`cfg-${f.key}`} className="block text-xs text-gray-400 mb-1">
                  {t(f.label)}
                </label>
                <input
                  id={`cfg-${f.key}`}
                  type={f.type ?? 'text'}
                  value={form.config[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm({ ...form, config: { ...form.config, [f.key]: e.target.value } })}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            ))}
            {form.provider === 'other' && (
              <div className="sm:col-span-3">
                <p className="text-xs text-gray-500">{t('cloudAccounts.credOtherHint')}</p>
              </div>
            )}
            {form.provider === 'kubernetes' && (
              <div className="sm:col-span-3">
                <p className="text-xs text-gray-500">{t('cloudAccounts.credK8sHint')}</p>
              </div>
            )}
            <div>
              <label htmlFor="external-id" className="block text-xs text-gray-400 mb-1">{t('cloudAccounts.externalId')}</label>
              <input
                id="external-id"
                value={form.external_id}
                onChange={(e) => setForm({ ...form, external_id: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="123456789012"
              />
            </div>
            <div className="sm:col-span-3 flex justify-end">
              <button
                type="submit"
                disabled={addMutation.isPending}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {addMutation.isPending ? t('cloudAccounts.adding') : t('cloudAccounts.addAccount')}
              </button>
            </div>
          </form>
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('cloudAccounts.loadFailed')}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-left">
              <th className="px-4 py-3 font-medium">{t('common.name')}</th>
              <th className="px-4 py-3 font-medium">{t('cloudAccounts.provider')}</th>
              <th className="px-4 py-3 font-medium">{t('cloudAccounts.currency')}</th>
              <th className="px-4 py-3 font-medium">{t('cloudAccounts.resources')}</th>
              <th className="px-4 py-3 font-medium">{t('cloudAccounts.lastSync')}</th>
              <th className="px-4 py-3 font-medium">{t('common.status')}</th>
              <th className="px-4 py-3 font-medium text-right">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">{t('common.loading')}</td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">{t('cloudAccounts.noAccounts')}</td>
              </tr>
            ) : (
              data.map((acct) => (
                <tr key={acct.id} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-white">{acct.name}</td>
                  <td className="px-4 py-3"><ProviderBadge provider={acct.provider} /></td>
                  <td className="px-4 py-3"><span className="px-2 py-0.5 rounded-full text-xs font-mono font-medium bg-gray-700 text-gray-300">{acct.currency}</span></td>
                  <td className="px-4 py-3 text-gray-300">{acct.resource_count.toLocaleString()}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {acct.last_sync_at ? new Date(acct.last_sync_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${acct.is_active ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
                        {acct.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                      {(() => {
                        const job = activeJobFor(acct.id, 'discovery')
                        if (job) {
                          return (
                            <span
                              data-testid={`job-chip-${acct.id}`}
                              className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-900/60 text-indigo-300 inline-flex items-center gap-1"
                            >
                              {t('cloudAccounts.syncInProgress')}
                              {job.progress_current !== null && job.progress_total !== null && job.progress_total > 0 && (
                                <span className="font-mono">
                                  {' '}{job.progress_current}/{job.progress_total}
                                </span>
                              )}
                            </span>
                          )
                        }
                        const billing = activeJobFor(acct.id, 'billing_import')
                        if (billing) {
                          return (
                            <span
                              data-testid={`job-chip-${acct.id}`}
                              className="px-2 py-0.5 rounded-full text-xs font-medium bg-sky-900/60 text-sky-300"
                            >
                              {t('cloudAccounts.importInProgress')}
                              {billing.phase ? ` · ${t(`jobs.phase.${billing.phase}`, { defaultValue: billing.phase })}` : ''}
                            </span>
                          )
                        }
                        return null
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setEditAcct(acct); setEditName(acct.name); setEditCurrency(acct.currency ?? 'USD'); setEditCreds({}); setEditConfig(prefillConfig(acct.config ?? {})); setEditClear(false) }}
                        className="px-2.5 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        onClick={() => testMutation.mutate(acct.id, {
                          onSuccess: (res) => {
                            const payload = (res as { data?: { data?: { success?: boolean; message?: string } } })?.data?.data
                            setAlertMsg(payload?.message ?? (payload?.success ? t('cloudAccounts.testSucceeded') : t('cloudAccounts.testCompleted')))
                          },
                          onError: () => setAlertMsg(t('cloudAccounts.testFailed')),
                        })}
                        className="px-2.5 py-1 text-xs rounded bg-sky-800/60 hover:bg-sky-700/60 text-sky-200"
                      >
                        {t('cloudAccounts.test')}
                      </button>
                      <button
                        onClick={() => syncMutation.mutate(acct.id)}
                        disabled={syncDisabled(acct.id)}
                        title={syncDisabled(acct.id) ? t('jobs.conflictBody') : undefined}
                        className="px-2.5 py-1 text-xs rounded bg-indigo-700/60 hover:bg-indigo-600/60 disabled:opacity-50 disabled:cursor-not-allowed text-indigo-100"
                      >
                        {syncDisabled(acct.id) ? t('cloudAccounts.syncing') : t('cloudAccounts.sync')}
                      </button>
                      <button
                        onClick={() => setDeleteAcct(acct)}
                        className="px-2.5 py-1 text-xs rounded bg-red-900/40 hover:bg-red-800/50 text-red-300"
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>

    {/* Edit Account Modal */}
    {editAcct && (
      <Modal title={t('cloudAccounts.editAccount')} onClose={() => setEditAcct(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const trimmed = editName.trim()
            const buildConfig: Record<string, unknown> = {}
            for (const f of CONFIG_FIELDS[editAcct.provider] ?? []) {
              const v = editConfig[f.key]?.trim()
              if (v) {
                buildConfig[f.key] = f.key === 'regions'
                  ? v.split(',').map((s) => s.trim()).filter(Boolean)
                  : v
              }
            }
            updateMutation.mutate({ id: editAcct.id, name: trimmed || editAcct.name, currency: editCurrency, credentials: editCreds, config: buildConfig })
            setEditAcct(null)
          }}
        >
          <div className="flex items-center gap-3 mb-4">
            <label className="block text-xs text-gray-400">{t('cloudAccounts.accountName')}</label>
            {editAcct.has_credentials && (
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/40 text-green-300">
                {t('cloudAccounts.credsConfigured')}
              </span>
            )}
          </div>
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-5"
          />
          <label className="block text-xs text-gray-400 mb-1">{t('cloudAccounts.currency')}</label>
          <p className="text-[11px] text-gray-500 mb-1.5">{t('cloudAccounts.currencyHint')}</p>
          <select
            value={editCurrency}
            onChange={(e) => setEditCurrency(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-5"
          >
            {['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          {(CREDENTIAL_FIELDS[editAcct.provider] ?? []).length > 0 && (
            <div className="border-t border-gray-800 pt-4 mb-5">
              <p className="text-xs text-gray-400 mb-3">{t('cloudAccounts.credentials')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(CREDENTIAL_FIELDS[editAcct.provider] ?? []).map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`edit-cred-${f.key}`} className="block text-xs text-gray-400 mb-1">
                      {t(f.label)}
                    </label>
                    <input
                      id={`edit-cred-${f.key}`}
                      type={f.secret ? 'password' : 'text'}
                      value={editCreds[f.key] ?? ''}
                      onChange={(e) => setEditCreds({ ...editCreds, [f.key]: e.target.value })}
                      placeholder={t('cloudAccounts.credsKeepPlaceholder')}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                ))}
              </div>
              {editAcct.has_credentials && (
                <button
                  type="button"
                  onClick={() => (editClear ? clearMutation.mutate(editAcct.id) : setEditClear(true))}
                  disabled={clearMutation.isPending}
                  className={`mt-3 px-3 py-1.5 text-xs rounded transition-colors ${
                    editClear ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-red-900/40 hover:bg-red-800/50 text-red-300'
                  }`}
                >
                  {clearMutation.isPending ? t('cloudAccounts.deleting') : (editClear ? t('cloudAccounts.credsClearConfirm') : t('cloudAccounts.credsClear'))}
                </button>
              )}
            </div>
          )}

          {(CONFIG_FIELDS[editAcct.provider] ?? []).length > 0 && (
            <div className="border-t border-gray-800 pt-4 mb-5">
              <p className="text-xs text-gray-400 mb-3">{t('cloudAccounts.configuration')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(CONFIG_FIELDS[editAcct.provider] ?? []).map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`edit-cfg-${f.key}`} className="block text-xs text-gray-400 mb-1">
                      {t(f.label)}
                    </label>
                    <input
                      id={`edit-cfg-${f.key}`}
                      type={f.type ?? 'text'}
                      value={editConfig[f.key] ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setEditConfig({ ...editConfig, [f.key]: e.target.value })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditAcct(null)}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={updateMutation.isPending}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm rounded-lg transition-colors"
            >
              {updateMutation.isPending ? t('cloudAccounts.saving') : t('common.save')}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* Delete Confirm Modal */}
    {deleteAcct && (
      <Modal title={t('cloudAccounts.deleteTitle')} onClose={() => setDeleteAcct(null)}>
        <p className="text-sm text-gray-300 mb-6">
          {t('cloudAccounts.deleteConfirm', { name: deleteAcct.name })}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setDeleteAcct(null)}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => { deleteMutation.mutate(deleteAcct.id); setDeleteAcct(null) }}
            disabled={deleteMutation.isPending}
            className="px-4 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-60 text-white text-sm rounded-lg transition-colors"
          >
            {deleteMutation.isPending ? t('cloudAccounts.deleting') : t('common.delete')}
          </button>
        </div>
      </Modal>
    )}

    {/* Test Result Alert Modal */}
    {alertMsg && (
      <Modal title={t('cloudAccounts.testTitle')} onClose={() => setAlertMsg(null)}>
        <p className="text-sm text-gray-300 mb-6">{alertMsg}</p>
        <div className="flex justify-end">
          <button
            onClick={() => setAlertMsg(null)}
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors"
          >
            {t('cloudAccounts.ok')}
          </button>
        </div>
      </Modal>
    )}
    </>
  )
}
