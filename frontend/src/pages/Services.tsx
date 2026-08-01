import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { Modal } from '../components/shared/Modal'

interface Service {
  id: string
  name: string
  display_name?: string
  description?: string
  owner_team?: string
  tier?: string
  lifecycle_state?: string
  created_at: string
  updated_at: string
}

interface ServiceCI {
  id: string
  ci_id: string
  ci_name: string
  ci_display_name?: string
  ci_type_name?: string
  role?: string
  lifecycle_state?: string
}

interface NewServiceForm {
  name: string
  display_name: string
  description: string
  owner_team: string
  tier: string
}

const TIER_COLORS: Record<string, string> = {
  critical: 'bg-red-900/40 text-red-300',
  high: 'bg-orange-900/40 text-orange-300',
  medium: 'bg-yellow-900/40 text-yellow-300',
  low: 'bg-gray-700 text-gray-400',
}

const TIERS = ['critical', 'high', 'medium', 'low']

function ServiceDetailPanel({
  service,
  onClose,
}: {
  service: Service
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const queryClient = useQueryClient()
  const [addCiId, setAddCiId] = useState('')
  const [addRole, setAddRole] = useState('')
  const [addError, setAddError] = useState('')

  const { data: cis = [] } = useQuery<ServiceCI[]>({
    queryKey: ['service-cis', orgId, service.id],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ServiceCI[] }>(
        `/orgs/${orgId}/services/${service.id}/cis`
      )
      return res.data ?? []
    },
  })

  const { data: costs } = useQuery<{ total_monthly_cost?: number }>({
    queryKey: ['service-costs', orgId, service.id],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { total_monthly_cost?: number } }>(
        `/orgs/${orgId}/services/${service.id}/costs`
      )
      return res.data ?? {}
    },
    retry: false,
  })

  const { data: allCIs = [] } = useQuery<{ id: string; name: string; display_name?: string }[]>({
    queryKey: ['cmdb-ids', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { id: string; name: string; display_name?: string }[] }>(
        `/orgs/${orgId}/cis`
      )
      return res.data ?? []
    },
  })

  const addCIMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/services/${service.id}/cis`, {
        ci_id: addCiId,
        role: addRole || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-cis', orgId, service.id] })
      queryClient.invalidateQueries({ queryKey: ['service-costs', orgId, service.id] })
      setAddCiId('')
      setAddRole('')
      setAddError('')
    },
    onError: () => setAddError(t('services.addCiFailed')),
  })

  const removeCIMutation = useMutation({
    mutationFn: (ciId: string) =>
      api.delete(`/orgs/${orgId}/services/${service.id}/cis/${ciId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-cis', orgId, service.id] })
      queryClient.invalidateQueries({ queryKey: ['service-costs', orgId, service.id] })
    },
  })

  const linkedCiIds = new Set(cis.map(c => c.ci_id))
  const availableCIs = allCIs.filter(c => !linkedCiIds.has(c.id))

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} aria-hidden="true" />
      <div className="fixed right-0 top-0 h-full w-[480px] bg-gray-900 border-l border-gray-800 z-50 overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-800 sticky top-0 bg-gray-900">
          <div>
            <h2 className="text-lg font-semibold text-white">{service.display_name || service.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{service.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none mt-0.5">✕</button>
        </div>

        <div className="p-5 space-y-6">
          {/* Info */}
          <section>
            <div className="flex flex-wrap gap-2 mb-3">
              {service.tier && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TIER_COLORS[service.tier] ?? 'bg-gray-700 text-gray-400'}`}>
                  {t(`status.${service.tier}`, { defaultValue: service.tier }).toUpperCase()}
                </span>
              )}
              {service.lifecycle_state && (
                <span className="px-2 py-0.5 bg-green-900/40 text-green-300 rounded-full text-xs font-medium">
                  {t(`lifecycle.${service.lifecycle_state}`, { defaultValue: service.lifecycle_state })}
                </span>
              )}
              {service.owner_team && (
                <span className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded-full text-xs">
                  👥 {service.owner_team}
                </span>
              )}
            </div>
            {service.description && (
              <p className="text-sm text-gray-400">{service.description}</p>
            )}
          </section>

          {/* Cost summary */}
          {costs?.total_monthly_cost != null && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{t('services.monthlyCost')}</h3>
              <p className="text-2xl font-bold text-white">
                ${costs.total_monthly_cost.toFixed(2)}
              </p>
            </section>
          )}

          {/* CIs */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {t('services.configurationItems', { count: cis.length })}
            </h3>

            {/* Add CI form */}
            <div className="bg-gray-800/70 rounded-lg p-3 mb-3 space-y-2">
              <select
                value={addCiId}
                onChange={e => setAddCiId(e.target.value)}
                className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-indigo-500"
              >
                <option value="">{t('services.selectCiPlaceholder')}</option>
                {availableCIs.map(c => (
                  <option key={c.id} value={c.id}>{c.display_name || c.name}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder={t('services.roleOptional')}
                value={addRole}
                onChange={e => setAddRole(e.target.value)}
                className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-indigo-500 placeholder-gray-500"
              />
              {addError && <p className="text-xs text-red-400">{addError}</p>}
              <button
                onClick={() => addCIMutation.mutate()}
                disabled={!addCiId || addCIMutation.isPending}
                className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs rounded transition-colors"
              >
                {addCIMutation.isPending ? t('services.adding') : t('services.addCi')}
              </button>
            </div>

            {cis.length === 0 ? (
              <p className="text-gray-600 text-sm">{t('services.noCisLinked')}</p>
            ) : (
              <div className="bg-gray-800/50 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-500 text-xs border-b border-gray-700">
                      <th className="px-3 py-2 text-left">{t('services.colCi')}</th>
                      <th className="px-3 py-2 text-left">{t('common.type')}</th>
                      <th className="px-3 py-2 text-left">{t('services.colRole')}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {cis.map(c => (
                      <tr key={c.id} className="border-b border-gray-700/50 last:border-0">
                        <td className="px-3 py-2 text-gray-200 font-medium">{c.ci_display_name || c.ci_name}</td>
                        <td className="px-3 py-2 text-gray-400 text-xs">{c.ci_type_name ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-500 text-xs">{c.role ?? '—'}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => removeCIMutation.mutate(c.ci_id)}
                            className="text-red-500/70 hover:text-red-400 text-xs"
                          >
                            {t('services.remove')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  )
}

export default function Services() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<Service | null>(null)
  const [formError, setFormError] = useState('')
  const [form, setForm] = useState<NewServiceForm>({
    name: '',
    display_name: '',
    description: '',
    owner_team: '',
    tier: 'medium',
  })
  const [editSvc, setEditSvc] = useState<Service | null>(null)
  const [editForm, setEditForm] = useState<Omit<NewServiceForm, 'name'>>({ display_name: '', description: '', owner_team: '', tier: 'medium' })

  const { data: services = [], isLoading } = useQuery<Service[]>({
    queryKey: ['services', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Service[] }>(`/orgs/${orgId}/services`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (body: NewServiceForm) => api.post(`/orgs/${orgId}/services`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services', orgId] })
      setShowForm(false)
      setForm({ name: '', display_name: '', description: '', owner_team: '', tier: 'medium' })
      setFormError('')
    },
    onError: () => setFormError(t('services.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/services/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services', orgId] }),
  })

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; body: Partial<NewServiceForm> }) =>
      api.put(`/orgs/${orgId}/services/${payload.id}`, payload.body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services', orgId] }),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setFormError('Name is required'); return }
    createMutation.mutate(form)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('services.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('services.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors"
        >
          {showForm ? t('common.cancel') : t('services.newService')}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-xl p-5 mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-200">{t('services.createService')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.nameRequired')}</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:border-indigo-500"
                placeholder={t('services.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.displayName')}</label>
              <input
                type="text"
                value={form.display_name}
                onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                className="w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:border-indigo-500"
                placeholder={t('services.displayNamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.ownerTeam')}</label>
              <input
                type="text"
                value={form.owner_team}
                onChange={e => setForm(f => ({ ...f, owner_team: e.target.value }))}
                className="w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:border-indigo-500"
                placeholder={t('services.ownerTeamPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.tier')}</label>
              <select
                value={form.tier}
                onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}
                className="w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:border-indigo-500"
              >
                {TIERS.map(tier => <option key={tier} value={tier}>{t(`status.${tier}`, { defaultValue: tier.charAt(0).toUpperCase() + tier.slice(1) })}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('common.description')}</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2}
              className="w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:border-indigo-500 resize-none"
              placeholder={t('services.descriptionPlaceholder')}
            />
          </div>
          {formError && <p className="text-sm text-red-400">{formError}</p>}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { setShowForm(false); setFormError('') }}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {createMutation.isPending ? t('services.creating') : t('services.createService')}
            </button>
          </div>
        </form>
      )}

      {/* Services table */}
      {isLoading ? (
        <div className="text-center py-20 text-gray-500">{t('services.loading')}</div>
      ) : services.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-4xl mb-3">🧩</p>
          <p className="text-gray-400 text-lg font-medium">{t('services.noServices')}</p>
          <p className="text-gray-600 text-sm mt-1">{t('services.emptyHint')}</p>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-gray-400 text-xs font-medium uppercase tracking-wider border-b border-gray-700">
                <th className="px-4 py-3 text-left">{t('services.colService')}</th>
                <th className="px-4 py-3 text-left">{t('services.tier')}</th>
                <th className="px-4 py-3 text-left">{t('services.colOwner')}</th>
                <th className="px-4 py-3 text-left">{t('services.colState')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {services.map(svc => (
                <tr
                  key={svc.id}
                  className="border-b border-gray-700/50 last:border-0 hover:bg-gray-700/30 cursor-pointer transition-colors"
                  onClick={() => setSelected(svc)}
                >
                  <td className="px-4 py-3">
                    <p className="text-white font-medium">{svc.display_name || svc.name}</p>
                    <p className="text-gray-500 text-xs">{svc.name}</p>
                    {svc.description && (
                      <p className="text-gray-400 text-xs mt-0.5 truncate max-w-xs">{svc.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {svc.tier ? (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TIER_COLORS[svc.tier] ?? 'bg-gray-700 text-gray-400'}`}>
                        {t(`status.${svc.tier}`, { defaultValue: svc.tier })}
                      </span>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{svc.owner_team ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{svc.lifecycle_state ? t(`lifecycle.${svc.lifecycle_state}`, { defaultValue: svc.lifecycle_state }) : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        setEditSvc(svc)
                        setEditForm({
                          display_name: svc.display_name ?? svc.name,
                          description: svc.description ?? '',
                          owner_team: svc.owner_team ?? '',
                          tier: svc.tier ?? 'medium',
                        })
                      }}
                      className="mr-3 text-gray-300 hover:text-white text-xs transition-colors"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); deleteMutation.mutate(svc.id) }}
                      className="text-red-500/60 hover:text-red-400 text-xs transition-colors"
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <ServiceDetailPanel service={selected} onClose={() => setSelected(null)} />
      )}

      {/* Edit Service Modal */}
      {editSvc && (
        <Modal title={t('services.editService')} onClose={() => setEditSvc(null)}>
          <form
            onSubmit={e => {
              e.preventDefault()
              updateMutation.mutate({ id: editSvc.id, body: editForm })
              setEditSvc(null)
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.displayName')}</label>
              <input
                autoFocus
                value={editForm.display_name}
                onChange={e => setEditForm(f => ({ ...f, display_name: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('common.description')}</label>
              <textarea
                value={editForm.description}
                onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.ownerTeam')}</label>
              <input
                value={editForm.owner_team}
                onChange={e => setEditForm(f => ({ ...f, owner_team: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('services.tier')}</label>
              <select
                value={editForm.tier}
                onChange={e => setEditForm(f => ({ ...f, tier: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {TIERS.map(tier => (
                  <option key={tier} value={tier}>{t(`status.${tier}`, { defaultValue: tier.charAt(0).toUpperCase() + tier.slice(1) })}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditSvc(null)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm rounded-lg transition-colors"
              >
                {updateMutation.isPending ? t('services.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
