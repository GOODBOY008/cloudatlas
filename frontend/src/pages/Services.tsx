import { Link } from 'react-router-dom'
import { NativeDialog } from '../components/shared/NativeDialog'
import { fmtMoney } from '../lib/format'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { Modal } from '../components/shared/Modal'
import { WorkspaceCatalog, type Deployment } from './WorkspaceCatalog'
import type { Organization } from '../types'
import { CiPicker } from '../components/shared/CiPicker'

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
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning/10 text-warning',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-emphasis text-secondary',
}

const TIERS = ['critical', 'high', 'medium', 'low']

function ServiceDetailPanel({
  service,
  onClose,
  writable = true,
}: {
  writable?: boolean
  service: Omit<Service, 'created_at' | 'updated_at'>
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

  const { data: costs } = useQuery<{ total_cost: number; currency: string }>({
    queryKey: ['service-costs', orgId, service.id],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { total_cost: number; currency: string } }>(
        `/orgs/${orgId}/services/${service.id}/costs`
      )
      return res.data
    },
    retry: false,
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
      queryClient.invalidateQueries({ queryKey: ['workspace-catalog', orgId] })
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
      queryClient.invalidateQueries({ queryKey: ['workspace-catalog', orgId] })
    },
  })

  return (
    <NativeDialog className="justify-end" label={service.display_name || service.name} onClose={onClose}>

      <div className="drawer-panel max-w-[480px]">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-edge sticky top-0 bg-surface">
          <div>
            <h2 className="text-lg font-semibold text-primary">{service.display_name || service.name}</h2>
            <p className="text-xs text-muted mt-0.5">{service.name}</p>
            <Link to={'/object-storage?service=' + service.id} className="text-sm text-accent">{t('storage.serviceBuckets')}</Link>
          </div>
          <button onClick={onClose} aria-label={t('common.close')} className="icon-button">✕</button>
        </div>

        <div className="p-5 space-y-6">
          {/* Info */}
          <section>
            <div className="flex flex-wrap gap-2 mb-3">
              {service.tier && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TIER_COLORS[service.tier] ?? 'bg-emphasis text-secondary'}`}>
                  {t(`status.${service.tier}`, { defaultValue: service.tier }).toUpperCase()}
                </span>
              )}
              {service.lifecycle_state && (
                <span className="px-2 py-0.5 bg-success/10 text-success rounded-full text-xs font-medium">
                  {t(`lifecycle.${service.lifecycle_state}`, { defaultValue: service.lifecycle_state })}
                </span>
              )}
              {service.owner_team && (
                <span className="px-2 py-0.5 bg-emphasis text-secondary rounded-full text-xs">
                  👥 {service.owner_team}
                </span>
              )}
            </div>
            {service.description && (
              <p className="text-sm text-secondary">{service.description}</p>
            )}
          </section>

          {/* Cost summary */}
          {costs?.total_cost != null && (
            <section>
              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-2">{t('services.lastThirtyDaysCost')}</h3>
              <p className="text-2xl font-semibold text-primary">
                {fmtMoney(costs.total_cost, costs.currency)}
              </p>
            </section>
          )}

          {/* CIs */}
          <section>
            <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-2">
              {t('services.configurationItems', { count: cis.length })}
            </h3>

            {writable && <form
              className="bg-subtle/70 rounded-lg p-3 mb-3 space-y-2"
              onSubmit={event => {
                event.preventDefault()
                if (addCiId && !addCIMutation.isPending) addCIMutation.mutate()
              }}
            >
              {orgId && <CiPicker
                orgId={orgId}
                excludeIds={cis.map(c => c.ci_id)}
                value={addCiId}
                onChange={setAddCiId}
                placeholder={t('services.selectCiPlaceholder')}
              />}
              <input
                name="serviceCiRole"
                aria-label={t('services.roleOptional')}
                type="text"
                placeholder={t('services.roleOptional')}
                value={addRole}
                onChange={e => setAddRole(e.target.value)}
                className="w-full bg-emphasis text-primary text-xs rounded px-2 py-1.5 border border-strong focus:outline-none focus:border-accent placeholder-muted"
              />
              {addError && <p role="alert" className="text-xs text-danger">{addError}</p>}
              <button
                type="submit"
                disabled={addCIMutation.isPending}
                className="btn-primary w-full"
              >
                {addCIMutation.isPending ? t('services.adding') : t('services.addCi')}
              </button>
            </form>}

            {cis.length === 0 ? (
              <p className="text-muted text-sm">{t('services.noCisLinked')}</p>
            ) : (
              <div className="bg-subtle/50 rounded-lg overflow-hidden">
                <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted text-xs border-b border-strong">
                      <th className="px-3 py-2 text-left">{t('services.colCi')}</th>
                      <th className="px-3 py-2 text-left">{t('common.type')}</th>
                      <th className="px-3 py-2 text-left">{t('services.colRole')}</th>
                      {writable && <th className="px-3 py-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {cis.map(c => (
                      <tr key={c.id} className="border-b border-strong/50 last:border-0">
                        <td className="px-3 py-2 text-primary font-medium">{c.ci_display_name || c.ci_name}</td>
                        <td className="px-3 py-2 text-secondary text-xs">{c.ci_type_name ?? '—'}</td>
                        <td className="px-3 py-2 text-muted text-xs">{c.role ?? '—'}</td>
                        {writable && <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => removeCIMutation.mutate(c.ci_id)}
                            className="text-danger/70 hover:text-danger text-xs"
                          >
                            {t('services.remove')}
                          </button>
                        </td>}
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>
            )}
          </section>
        </div>
      </div>
    </NativeDialog>
  )
}

function BusinessServices({ org }: { org: Organization }) {
  const [selected, setSelected] = useState<{ deployment: Deployment; writable: boolean } | null>(null)
  return <>
    <WorkspaceCatalog org={org} openDeployment={(deployment, writable) => setSelected({ deployment, writable })} />
    {selected && <ServiceDetailPanel service={selected.deployment} writable={selected.writable} onClose={() => setSelected(null)} />}
  </>
}

export default function Services() {
  const currentOrg = useOrgStore(state => state.currentOrg)
  return currentOrg?.workspace ? <BusinessServices key={currentOrg.id} org={currentOrg} /> : <LegacyServices />
}

function LegacyServices() {
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
    <div className="space-y-6">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('services.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('services.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="btn-primary"
        >
          {showForm ? t('common.cancel') : t('services.newService')}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-subtle rounded-xl p-5 mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-primary">{t('services.createService')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-secondary mb-1">{t('services.nameRequired')}</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-emphasis text-primary text-sm rounded px-3 py-2 border border-strong focus:outline-none focus:border-accent"
                placeholder={t('services.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('services.displayName')}</label>
              <input
                type="text"
                value={form.display_name}
                onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                className="w-full bg-emphasis text-primary text-sm rounded px-3 py-2 border border-strong focus:outline-none focus:border-accent"
                placeholder={t('services.displayNamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('services.ownerTeam')}</label>
              <input
                type="text"
                value={form.owner_team}
                onChange={e => setForm(f => ({ ...f, owner_team: e.target.value }))}
                className="w-full bg-emphasis text-primary text-sm rounded px-3 py-2 border border-strong focus:outline-none focus:border-accent"
                placeholder={t('services.ownerTeamPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('services.tier')}</label>
              <select
                value={form.tier}
                onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}
                className="w-full bg-emphasis text-primary text-sm rounded px-3 py-2 border border-strong focus:outline-none focus:border-accent"
              >
                {TIERS.map(tier => <option key={tier} value={tier}>{t(`status.${tier}`, { defaultValue: tier.charAt(0).toUpperCase() + tier.slice(1) })}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">{t('common.description')}</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2}
              className="w-full bg-emphasis text-primary text-sm rounded px-3 py-2 border border-strong focus:outline-none focus:border-accent resize-none"
              placeholder={t('services.descriptionPlaceholder')}
            />
          </div>
          {formError && <p className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { setShowForm(false); setFormError('') }}
              className="px-4 py-2 text-sm text-secondary hover:text-primary transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="btn-primary"
            >
              {createMutation.isPending ? t('services.creating') : t('services.createService')}
            </button>
          </div>
        </form>
      )}

      {/* Services table */}
      {isLoading ? (
        <div className="text-center py-20 text-muted">{t('services.loading')}</div>
      ) : services.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-4xl mb-3">🧩</p>
          <p className="text-secondary text-lg font-medium">{t('services.noServices')}</p>
          <p className="text-muted text-sm mt-1">{t('services.emptyHint')}</p>
        </div>
      ) : (
        <div className="bg-subtle rounded-xl overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><table className="w-full">
            <thead>
              <tr className="text-secondary text-xs font-medium uppercase tracking-wider border-b border-strong">
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
                  className="border-b border-strong/50 last:border-0 hover:bg-emphasis/30 cursor-pointer transition-colors"
                  onClick={() => setSelected(svc)}
                >
                  <td className="px-4 py-3">
                    <p className="text-primary font-medium">{svc.display_name || svc.name}</p>
                    <p className="text-muted text-xs">{svc.name}</p>
                    {svc.description && (
                      <p className="text-secondary text-xs mt-0.5 truncate max-w-xs">{svc.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {svc.tier ? (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TIER_COLORS[svc.tier] ?? 'bg-emphasis text-secondary'}`}>
                        {t(`status.${svc.tier}`, { defaultValue: svc.tier })}
                      </span>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3 text-secondary text-sm">{svc.owner_team ?? '—'}</td>
                  <td className="px-4 py-3 text-secondary text-sm">{svc.lifecycle_state ? t(`lifecycle.${svc.lifecycle_state}`, { defaultValue: svc.lifecycle_state }) : '—'}</td>
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
                      className="mr-3 text-secondary hover:text-primary text-xs transition-colors"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); deleteMutation.mutate(svc.id) }}
                      className="text-danger/60 hover:text-danger text-xs transition-colors"
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
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
              <label className="block text-xs text-secondary mb-1">{t('services.displayName')}</label>
              <input
                autoFocus
                value={editForm.display_name}
                onChange={e => setEditForm(f => ({ ...f, display_name: e.target.value }))}
                className="w-full px-3 py-2 bg-subtle border border-strong rounded-lg text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('common.description')}</label>
              <textarea
                value={editForm.description}
                onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 bg-subtle border border-strong rounded-lg text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('services.ownerTeam')}</label>
              <input
                value={editForm.owner_team}
                onChange={e => setEditForm(f => ({ ...f, owner_team: e.target.value }))}
                className="w-full px-3 py-2 bg-subtle border border-strong rounded-lg text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('services.tier')}</label>
              <select
                value={editForm.tier}
                onChange={e => setEditForm(f => ({ ...f, tier: e.target.value }))}
                className="w-full px-3 py-2 bg-subtle border border-strong rounded-lg text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
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
                className="px-3 py-1.5 text-sm text-secondary hover:text-primary transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="btn-primary"
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
