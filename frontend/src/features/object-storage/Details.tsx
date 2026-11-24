import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { NativeDialog } from '../../components/shared/NativeDialog'
import api from '../../lib/api'
import { fmtMoney } from '../../lib/format'
import type { Organization } from '../../types'
import { Bills } from './Billing'
import { FindingsPanel } from './Inventory'
import { bytes, failure, type Detail, type Period } from './types'

interface Choice {
  id: string
  name: string
  display_name?: string
}
interface Deployment extends Choice {
  catalog_service_id: string | null
  is_default: boolean
}
function Ownership({ org, bucket, writable }: { org: Organization; bucket: Detail; writable: boolean }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [service, setService] = useState('')
  const [deployment, setDeployment] = useState('')
  const grouped = !!org.workspace
  const base = `/orgs/${org.id}`
  const choices = useQuery({
    queryKey: ['storage-service-choices', org.id, grouped],
    enabled: writable && !!bucket.ci_id,
    queryFn: async ({ signal }) => {
      if (grouped)
        return (
          await api.get<{ data: { services: Choice[]; deployments: Deployment[] } }>(base + '/catalog', {
            signal,
          })
        ).data.data
      const services: Choice[] = []
      let page = 1
      while (true) {
        const { data } = await api.get<{ data: Choice[]; meta: { total_pages: number } }>(
          base + '/services',
          { params: { page, per_page: 200 }, signal },
        )
        services.push(...data.data)
        if (page >= data.meta.total_pages) break
        page++
      }
      return { services, deployments: [] as Deployment[] }
    },
  })
  const mutation = useMutation({
    mutationFn: async (remove: string | null) => {
      if (remove) return api.delete(`${base}/services/${remove}/cis/${bucket.ci_id}`)
      return grouped
        ? api.post(`${base}/catalog/services/${service}/cis`, {
            ci_id: bucket.ci_id,
            deployment_id: deployment || null,
          })
        : api.post(`${base}/services/${service}/cis`, { ci_id: bucket.ci_id })
    },
    onSuccess: () => {
      setService('')
      setDeployment('')
      for (const key of [
        'storage-detail',
        'storage-overview',
        'storage-bills',
        'storage-findings',
        'workspace-catalog',
        'service-cis',
        'service-costs',
        'services',
      ])
        void client.invalidateQueries({ queryKey: [key, org.id] })
    },
  })
  return (
    <section>
      <div className="storage-row">
        <h4>{t('storage.ownership')}</h4>
        {bucket.ci_id && (
          <Link className="text-accent" to={'/model-topology?ci=' + bucket.ci_id}>
            {t('storage.ci')}
          </Link>
        )}
      </div>
      {bucket.owners.length === 0 ? (
        <p className="storage-muted">{t('storage.noOwner')}</p>
      ) : (
        <ul className="storage-records">
          {bucket.owners.map((o) => (
            <li key={o.deployment_id}>
              <strong>
                {o.system_name ? o.system_name + ' → ' : ''}
                {o.service_name}
              </strong>
              <small>
                {o.team_name || t('storage.noTeam')} ·{' '}
                {o.is_default ? t('storage.defaultDeployment') : o.deployment_name} → {bucket.name}
              </small>
              {writable && (
                <button
                  className="storage-link"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(o.deployment_id)}
                >
                  {t('storage.unlink')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {writable && bucket.ci_id && (
        <form
          className="storage-form"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate(null)
          }}
        >
          <div className="storage-fields">
            <label>
              {t('storage.service')}
              <select
                value={service}
                onChange={(e) => {
                  setService(e.target.value)
                  setDeployment('')
                }}
                required
              >
                <option value="">{t('storage.selectService')}</option>
                {choices.data?.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name || s.name}
                  </option>
                ))}
              </select>
            </label>
            {grouped && service && (
              <label>
                {t('storage.deployment')}
                <select value={deployment} onChange={(e) => setDeployment(e.target.value)}>
                  <option value="">{t('storage.defaultDeployment')}</option>
                  {choices.data?.deployments
                    .filter((d) => d.catalog_service_id === service && !d.is_default)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.display_name || d.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          {choices.isError && <p role="alert">{failure(choices.error, t('storage.failed'))}</p>}
          {choices.data && !choices.data.services.length && (
            <Link to="/services" className="text-accent">
              {t('storage.openServices')}
            </Link>
          )}
          <button className="btn-primary" disabled={!service || mutation.isPending}>
            {t('storage.bind')}
          </button>
        </form>
      )}
      {!bucket.ci_id && <p className="storage-muted">{t('storage.noCi')}</p>}
      {mutation.isError && <p role="alert">{failure(mutation.error, t('storage.failed'))}</p>}
    </section>
  )
}
function Allocation({
  org,
  bucket,
  period,
  currency,
  allowed,
}: {
  org: string
  bucket: Detail
  period: Period
  currency: string
  allowed: boolean
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const services = [...new Map(bucket.owners.map((o) => [o.service_id, o.service_name])).entries()]
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (form: FormData) =>
      api.put(`/orgs/${org}/object-storage/buckets/${bucket.id}/allocations`, {
        effective_from: form.get('effective_from'),
        weights: Object.fromEntries(services.map(([id]) => [id, Math.round(Number(form.get(id)) * 100)])),
      }),
    onSuccess: () => {
      setOpen(false)
      for (const key of ['storage-overview', 'storage-bills', 'storage-detail'])
        void client.invalidateQueries({ queryKey: [key, org] })
    },
  })
  return (
    <section>
      <div className="storage-row">
        <h4>{t('storage.serviceAllocation')}</h4>
        {allowed && services.length > 1 && (
          <button className="btn-secondary" onClick={() => setOpen(!open)}>
            {t(open ? 'common.cancel' : 'storage.setShares')}
          </button>
        )}
      </div>
      {bucket.service_costs.length > 0 ? (
        <dl className="storage-facts">
          {bucket.service_costs.map((s) => (
            <div key={s.service_id}>
              <dt>{s.service_name}</dt>
              <dd>{fmtMoney(s.cost, currency)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="storage-muted">
          {t(services.length > 1 ? 'storage.sharedPending' : 'storage.noAttributedCharges')}
        </p>
      )}
      {bucket.rules.map((r) => (
        <small key={r.effective_from}>
          {t('storage.effective')} {r.effective_from} ·{' '}
          {Object.entries(r.weights)
            .map(([id, v]) => (services.find(([key]) => key === id)?.[1] || id) + ' ' + v / 100 + '%')
            .join(' / ')}
        </small>
      ))}
      {open && (
        <form
          className="storage-form"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(new FormData(e.currentTarget))
          }}
        >
          <label>
            {t('storage.effective')}
            <input name="effective_from" type="date" required defaultValue={period.start_date} />
          </label>
          <div className="storage-fields">
            {services.map(([id, name]) => (
              <label key={id}>
                {name} (%)
                <input type="number" name={id} step=".01" min=".01" max="100" required />
              </label>
            ))}
          </div>
          {save.isError && <p role="alert">{failure(save.error, t('storage.failed'))}</p>}
          <button className="btn-primary" disabled={save.isPending}>
            {t('storage.saveShares')}
          </button>
        </form>
      )}
    </section>
  )
}
export function BucketDetails({
  org,
  id,
  period,
  currency,
  canBind,
  canImport,
  canAllocate,
  close,
}: {
  org: Organization
  id: string
  period: Period
  currency: string
  canBind: boolean
  canImport: boolean
  canAllocate: boolean
  close: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('asset')
  const query = useQuery({
    queryKey: ['storage-detail', org.id, id, period],
    queryFn: async ({ signal }) =>
      (
        await api.get<{ data: Detail }>(`/orgs/${org.id}/object-storage/buckets/${id}`, {
          params: period,
          signal,
        })
      ).data.data,
    refetchInterval: (q) => (q.state.data?.imports.some((i) => i.status === 'pending') ? 1500 : false),
  })
  const b = query.data
  const money = (v: number | null) => (v === null ? t('storage.noBillingShort') : fmtMoney(v, currency))
  return (
    <NativeDialog className="justify-end" label={b?.name || t('storage.bucket')} onClose={close}>
      <div className="drawer-panel storage-drawer">
        <header className="storage-detail-header">
          <div>
            <p className="storage-muted">
              {t('nav.objectStorage')} · {b?.environment}
            </p>
            <h2>{b?.name || t('storage.bucket')}</h2>
            <p>
              {b?.account_name} {b?.region && ' · ' + b.region}
            </p>
          </div>
          <button className="icon-button" onClick={close} aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </header>
        <div className="storage-detail-body">
          {query.isPending ? (
            <p role="status">{t('common.loading')}</p>
          ) : query.isError || !b ? (
            <p role="alert">{failure(query.error, t('storage.failed'))}</p>
          ) : (
            <>
              <div className="storage-tabs" role="group" aria-label={t('storage.bucket')}>
                {['asset', 'cost', 'opportunities'].map((k) => (
                  <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
                    {t('storage.tab.' + k)}
                  </button>
                ))}
              </div>
              {tab === 'asset' && (
                <div className="storage-detail-stack">
                  <Ownership org={org} bucket={b} writable={canBind} />
                  <section>
                    <h4>{t('storage.identifiers')}</h4>
                    <dl className="storage-facts">
                      <div>
                        <dt>{t('storage.resourceId')}</dt>
                        <dd>{b.cloud_resource_id}</dd>
                      </div>
                      <div>
                        <dt>{t('storage.lastSeen')}</dt>
                        <dd>{new Date(b.last_seen).toLocaleString()}</dd>
                      </div>
                      {Object.entries(b.tags || {}).map(([key, val]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{String(val)}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              )}
              {tab === 'cost' && (
                <div className="storage-detail-stack">
                  <section>
                    <h4>
                      {t('storage.periodCost')} · {period.start_date} – {period.end_date}
                    </h4>
                    <strong className="storage-amount">{money(b.cost)}</strong>
                    {b.breakdown.length > 0 && (
                      <dl className="storage-facts">
                        {b.breakdown.map((x) => (
                          <div key={x.category}>
                            <dt>{t('storage.category.' + x.category)}</dt>
                            <dd>{money(x.cost)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </section>
                  <Allocation
                    org={org.id}
                    bucket={b}
                    period={period}
                    currency={currency}
                    allowed={canAllocate}
                  />
                  <section>
                    <h4>{t('storage.usage')}</h4>
                    <dl className="storage-facts">
                      <div>
                        <dt>{t('storage.objects')}</dt>
                        <dd>{b.usage.object_count?.toLocaleString() ?? t('storage.notCollected')}</dd>
                      </div>
                      <div>
                        <dt>{t('storage.capacity')}</dt>
                        <dd>
                          {b.usage.size_bytes === null
                            ? t('storage.notCollected')
                            : bytes(b.usage.size_bytes)}
                        </dd>
                      </div>
                    </dl>
                    {b.usage.latest_at && (
                      <p className="storage-muted">
                        {t('storage.covered')} · {b.usage.covered_objects} · {bytes(b.usage.covered_bytes)} ·{' '}
                        {new Date(b.usage.latest_at).toLocaleString()}
                        {b.usage.full_at &&
                          ' · ' +
                            t('storage.fullSnapshot') +
                            ' ' +
                            new Date(b.usage.full_at).toLocaleString()}
                      </p>
                    )}
                  </section>
                  {b.trend.length > 0 && (
                    <section>
                      <h4>{t('storage.trend')}</h4>
                      <ul className="storage-trend">
                        {b.trend.map((day) => (
                          <li key={day.date}>
                            <time>{day.date}</time>
                            <meter
                              min={0}
                              max={Math.max(1, ...b.trend.map((x) => Math.abs(x.cost)))}
                              value={Math.abs(day.cost)}
                              aria-label={day.date}
                            />
                            <span>{money(day.cost)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <Bills org={org.id} period={period} bucket={id} />
                </div>
              )}
              {tab === 'opportunities' && (
                <FindingsPanel detail={b} org={org.id} currency={currency} canImport={canImport} />
              )}
            </>
          )}
        </div>
      </div>
    </NativeDialog>
  )
}
