import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ProviderMeta {
  provider: string
  label: string
  icon: string
  fields: string[]
}

interface Integration {
  id: string
  provider: string
  name: string
  config: Record<string, string>
  is_active: boolean
  status: string
  last_checked_at: string | null
  created_at: string
}

interface IntegrationList {
  data: Integration[]
  providers: ProviderMeta[]
}

export default function Integrations() {
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [showModal, setShowModal] = useState(false)
  const [provider, setProvider] = useState('slack')
  const [name, setName] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')

  const { data: list, isLoading, isError } = useQuery<IntegrationList>({
    queryKey: ['integrations', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await api.get<IntegrationList>(`/orgs/${orgId}/integrations`)
      return res.data
    },
  })

  const integrations = list?.data ?? []
  const providers = list?.providers ?? []

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post(`/orgs/${orgId}/integrations`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations', orgId] })
      setShowModal(false)
      setName('')
      setFieldValues({})
      setFormError('')
    },
    onError: () => setFormError(t('integrations.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/integrations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations', orgId] }),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.put(`/orgs/${orgId}/integrations/${id}`, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations', orgId] }),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgId}/integrations/${id}/test`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations', orgId] }),
  })

  const meta = providers.find((p) => p.provider === provider)

  function openCreate(p: string) {
    setProvider(p)
    setName('')
    setFieldValues({})
    setFormError('')
    setShowModal(true)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!name.trim()) {
      setFormError(t('integrations.nameRequired'))
      return
    }
    const config: Record<string, string> = {}
    for (const [k, v] of Object.entries(fieldValues)) {
      if (v.trim()) config[k] = v.trim()
    }
    if (Object.keys(config).length === 0) {
      setFormError(t('integrations.fieldRequired'))
      return
    }
    createMutation.mutate({ provider, name: name.trim(), config })
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('integrations.title')}</h2>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('integrations.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : (
        <>
          {/* Provider cards */}
          <h3 className="text-sm font-semibold text-white mb-3">{t('integrations.addConnection')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-8">
            {providers.map((p) => (
              <button
                key={p.provider}
                onClick={() => openCreate(p.provider)}
                className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center hover:border-indigo-600 transition-colors"
              >
                <span className="text-3xl block">{p.icon}</span>
                <span className="block text-sm text-white mt-2">{p.label}</span>
                <span className="block text-xs text-gray-600 mt-0.5">{p.provider}</span>
              </button>
            ))}
          </div>

          {/* Configured integrations */}
          <h3 className="text-sm font-semibold text-white mb-3">{t('integrations.configured')}</h3>
          {integrations.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
              {t('integrations.empty')}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {integrations.map((it) => {
                const pmeta = providers.find((p) => p.provider === it.provider)
                return (
                  <div key={it.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{pmeta?.icon ?? '🔗'}</span>
                        <div>
                          <p className="text-sm font-medium text-white">{it.name}</p>
                          <p className="text-xs text-gray-500">{pmeta?.label ?? it.provider}</p>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          it.status === 'connected'
                            ? 'bg-green-900/40 text-green-300'
                            : it.status === 'error'
                              ? 'bg-red-900/40 text-red-300'
                              : 'bg-gray-800 text-gray-400'
                        }`}
                      >
                        {t(`integrations.status.${it.status}`, { defaultValue: it.status })}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-xs">
                      <button
                        onClick={() => testMutation.mutate(it.id)}
                        disabled={testMutation.isPending}
                        className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg disabled:opacity-50"
                      >
                        {t('cloudAccounts.test')}
                      </button>
                      <button
                        onClick={() => toggleMutation.mutate({ id: it.id, is_active: !it.is_active })}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          it.is_active ? 'bg-green-600' : 'bg-gray-700'
                        }`}
                        title={it.is_active ? t('common.active') : t('common.inactive')}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                            it.is_active ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                        />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(t('integrations.deleteConfirm', { name: it.name }))) deleteMutation.mutate(it.id)
                        }}
                        className="text-red-400 hover:text-red-300"
                      >
                        {t('common.delete')}
                      </button>
                      {it.last_checked_at && (
                        <span className="ml-auto text-gray-600">
                          {t('integrations.checkedAt', { date: new Date(it.last_checked_at).toLocaleDateString() })}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {showModal && meta && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {meta.icon} {t('integrations.connectProvider', { name: meta.label })}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputCls}
                  placeholder={`my-${meta.provider}-connection`}
                />
              </div>
              {meta.fields.map((f) => (
                <div key={f}>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    {f.replace(/_/g, ' ')}
                  </label>
                  <input
                    type={f.includes('token') || f.includes('key') || f.includes('secret') ? 'password' : 'text'}
                    value={fieldValues[f] ?? ''}
                    onChange={(e) => setFieldValues({ ...fieldValues, [f]: e.target.value })}
                    className={inputCls}
                  />
                </div>
              ))}
              {formError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('integrations.connect')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
