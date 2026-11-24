import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { NativeDialog } from '../components/shared/NativeDialog'
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

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('integrations.title')}</h1>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('integrations.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : (
        <>
          {/* Provider cards */}
          <h3 className="text-sm font-semibold text-primary mb-3">{t('integrations.addConnection')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-8">
            {providers.map((p) => (
              <button
                key={p.provider}
                onClick={() => openCreate(p.provider)}
                className="bg-surface border border-edge rounded-xl p-4 text-center hover:border-accent transition-colors"
              >
                <span className="text-3xl block">{p.icon}</span>
                <span className="block text-sm text-primary mt-2">{p.label}</span>
                <span className="block text-xs text-muted mt-0.5">{p.provider}</span>
              </button>
            ))}
          </div>

          {/* Configured integrations */}
          <h3 className="text-sm font-semibold text-primary mb-3">{t('integrations.configured')}</h3>
          {integrations.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {t('integrations.empty')}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {integrations.map((it) => {
                const pmeta = providers.find((p) => p.provider === it.provider)
                return (
                  <div key={it.id} className="bg-surface border border-edge rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{pmeta?.icon ?? '🔗'}</span>
                        <div>
                          <p className="text-sm font-medium text-primary">{it.name}</p>
                          <p className="text-xs text-muted">{pmeta?.label ?? it.provider}</p>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          it.status === 'connected'
                            ? 'bg-success/10 text-success'
                            : it.status === 'error'
                              ? 'bg-danger/10 text-danger'
                              : 'bg-subtle text-secondary'
                        }`}
                      >
                        {t(`integrations.status.${it.status}`, { defaultValue: it.status })}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-xs">
                      <Button
                        onClick={() => testMutation.mutate(it.id)}
                        disabled={testMutation.isPending}
                      >
                        {t('cloudAccounts.test')}
                      </Button>
                      <button
                        onClick={() => toggleMutation.mutate({ id: it.id, is_active: !it.is_active })}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          it.is_active ? 'bg-success-solid' : 'bg-emphasis'
                        }`}
                        title={it.is_active ? t('common.active') : t('common.inactive')}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-surface transition-transform ${
                            it.is_active ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                        />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(t('integrations.deleteConfirm', { name: it.name }))) deleteMutation.mutate(it.id)
                        }}
                        className="text-danger hover:text-danger"
                      >
                        {t('common.delete')}
                      </button>
                      {it.last_checked_at && (
                        <span className="ml-auto text-muted">
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
        <NativeDialog className="items-center justify-center p-4" label={t('integrations.connectProvider', { name: meta.label })} onClose={() => setShowModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">
              {meta.icon} {t('integrations.connectProvider', { name: meta.label })}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input
                  label={t('common.name')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full"
                  placeholder={`my-${meta.provider}-connection`}
                />
              </div>
              {meta.fields.map((f) => (
                <div key={f}>
                  <Input
                    label={f.replace(/_/g, ' ')}
                    type={f.includes('token') || f.includes('key') || f.includes('secret') ? 'password' : 'text'}
                    value={fieldValues[f] ?? ''}
                    onChange={(e) => setFieldValues({ ...fieldValues, [f]: e.target.value })}
                    className="w-full"
                  />
                </div>
              ))}
              {formError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowModal(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending}
                >
                  {t('integrations.connect')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
