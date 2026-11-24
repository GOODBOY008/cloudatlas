import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../../components/shared/SelectField'
import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../../lib/api'
import { fmtMoney } from '../../lib/format'
import { Pager } from './Billing'
import { bytes, failure, type Detail, type Envelope, type Findings, type Opportunity } from './types'

function InventoryForm({ url, currency, done }: { url: string; currency: string; done: () => void }) {
  const { t } = useTranslation()
  const [priced, setPriced] = useState(false)
  const [native, setNative] = useState(false)
  const upload = useMutation({
    mutationFn: (body: FormData) =>
      api.post(url, body, { headers: { 'Content-Type': 'multipart/form-data' } }),
    onSuccess: done,
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const metadata = {
      prefix: String(form.get('prefix') || ''),
      captured_at: native ? undefined : new Date(String(form.get('captured'))).toISOString(),
      rate: priced
        ? {
            storage_class: form.get('class'),
            currency,
            per_gib_month: Number(form.get('rate')),
            source: form.get('source'),
          }
        : undefined,
    }
    const body = new FormData()
    body.append('metadata', JSON.stringify(metadata))
    for (const file of form.getAll('file')) body.append('file', file)
    if (native) {
      const manifest = form.get('manifest')
      if (manifest instanceof File) body.append('manifest', manifest)
    }
    upload.mutate(body)
  }
  return (
    <form className="storage-form" onSubmit={submit}>
      <label>
        {t('storage.format')}
        <SelectField
          aria-label={t('storage.format')}
          value={native ? 'native' : 'csv'}
          onValueChange={value => setNative(value === 'native')}
          items={[
            { value: "csv", label: t('storage.normalized') },
            { value: "native", label: t('storage.providerManifest') },
          ]}
        />
      </label>
      <div className="storage-fields">
        <label>
          {t('storage.prefix')}
          <Input aria-label={t('storage.prefix')} name="prefix" placeholder={t('storage.fullBucket')} maxLength={1024} />
        </label>
        {!native && (
          <label>
            {t('storage.captured')}
            <Input aria-label={t('storage.captured')} name="captured" type="datetime-local" step="1" required />
          </label>
        )}
      </div>
      {native && (
        <label>
          manifest.json
          <input type="file" name="manifest" accept=".json" required />
        </label>
      )}
      <label>
        {t(native ? 'storage.shards' : 'storage.csv')}
        <input key={String(native)} type="file" name="file" accept=".csv,.gz" multiple={native} required />
      </label>
      {!native && (
        <p>
          <a
            className="text-accent"
            download="object-inventory.csv"
            href={
              'data:text/csv;charset=UTF-8,' +
              encodeURIComponent(
                'key,size,version_id,is_latest,is_delete_marker,etag,full_sha256,storage_class\n',
              )
            }
          >
            {t('storage.template')}
          </a>{' '}
          · {t('storage.hashHint')}
        </p>
      )}
      <p className="storage-muted">{t('storage.uploadLimit')}</p>
      <label className="storage-checkbox">
        <input type="checkbox" checked={priced} onChange={(e) => setPriced(e.target.checked)} />
        {t('storage.addRate')}
      </label>
      {priced && (
        <div className="storage-fields">
          <label>
            {t('storage.storageClass')}
            <Input aria-label={t('storage.storageClass')} required name="class" maxLength={128} />
          </label>
          <label>
            {t('storage.unitRate', { currency })}
            <Input aria-label={t('storage.unitRate', { currency })} required name="rate" type="number" min="0" max="1000000" step="any" />
          </label>
          <label>
            {t('storage.priceSource')}
            <Input aria-label={t('storage.priceSource')} required name="source" maxLength={512} />
          </label>
        </div>
      )}
      <label className="storage-checkbox">
        <input type="checkbox" required />
        {t('storage.confirmCoverage')}
      </label>
      {upload.isError && <p role="alert">{failure(upload.error, t('storage.failed'))}</p>}
      <Button variant="primary" type="submit" disabled={upload.isPending}>
        {t(upload.isPending ? 'storage.uploading' : 'storage.queue')}
      </Button>
    </form>
  )
}
export function InventoryPanel({
  detail,
  org,
  currency,
  canImport,
}: {
  detail: Detail
  org: string
  currency: string
  canImport: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const client = useQueryClient()
  return (
    <section>
      <div className="storage-row">
        <h4>{t('storage.inventory')}</h4>
        {canImport && (
          <Button onClick={() => setOpen(!open)}>
            {t(open ? 'common.cancel' : 'storage.import')}
          </Button>
        )}
      </div>
      {open && (
        <InventoryForm
          url={`/orgs/${org}/object-storage/buckets/${detail.id}/inventories`}
          currency={currency}
          done={() => {
            setOpen(false)
            void client.invalidateQueries({ queryKey: ['storage-detail', org, detail.id] })
          }}
        />
      )}
      {detail.imports.length === 0 ? (
        <p className="storage-muted">{t('storage.noInventory')}</p>
      ) : (
        <ul className="storage-records">
          {detail.imports.map((i) => (
            <li key={i.id}>
              <strong>{i.prefix || t('storage.fullBucket')}</strong> ·{' '}
              {new Date(i.captured_at).toLocaleString()} · {t('storage.status.' + i.status)}
              {i.status === 'complete' && (
                <small>
                  {t('storage.objects')} {i.object_count} · {bytes(i.size_bytes)}
                </small>
              )}
              {i.error && <small role="alert">{i.error}</small>}
              {i.rate_source && (
                <small>
                  {i.rate_class} · {i.rate_gib_month} {i.rate_currency}/GiB/{t('storage.month')} ·{' '}
                  {i.rate_source}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
function Members({ group }: { group: Opportunity }) {
  const { t } = useTranslation()
  return (
    <ul className="storage-records">
      {group.members.map((m) => (
        <li key={m.bucket_id + '|' + m.object_key}>
          <strong>{m.bucket_name}</strong> / {m.object_key}
          <small>
            {t('storage.version')} · {m.version_id || '—'} · {m.storage_class || '—'} ·{' '}
            {m.services.join(' / ') || t('storage.alloc.unclaimed')}
          </small>
          <small>
            {new Date(m.captured_at).toLocaleString()} · {t('storage.prefix')}{' '}
            {m.prefix || t('storage.fullBucket')}
          </small>
          {m.rate_source && (
            <small>
              {t('storage.priceSource')} · {m.rate_class} · {m.rate_gib_month} {m.rate_currency}/GiB/
              {t('storage.month')} · {m.rate_source}
            </small>
          )}
        </li>
      ))}
    </ul>
  )
}
export function FindingsPanel({
  detail,
  org,
  currency,
  canImport,
}: {
  detail: Detail
  org: string
  currency: string
  canImport: boolean
}) {
  const { t } = useTranslation()
  const [group, setGroup] = useState('')
  const [page, setPage] = useState(1)
  const latest = detail.imports
    .filter((i) => i.status === 'complete')
    .map((i) => i.id)
    .join(',')
  const findings = useQuery({
    queryKey: ['storage-findings', org, detail.id, latest, group, page],
    queryFn: async ({ signal }) =>
      (
        await api.get<Envelope<Findings>>(`/orgs/${org}/object-storage/buckets/${detail.id}/opportunities`, {
          params: { group_id: group, page, per_page: 10 },
          signal,
        })
      ).data,
  })
  function choose(id: string) {
    setGroup(id)
    setPage(1)
  }
  return (
    <div className="storage-detail-stack">
      <InventoryPanel detail={detail} org={org} currency={currency} canImport={canImport} />
      <section>
        <div className="storage-row">
          <h4>{t('storage.objectFindings')}</h4>
          {group && (
            <Button onClick={() => choose('')}>
              {t('storage.allGroups')}
            </Button>
          )}
        </div>
        {findings.isPending ? (
          <p role="status">{t('common.loading')}</p>
        ) : findings.isError ? (
          <p role="alert">{failure(findings.error, t('storage.failed'))}</p>
        ) : (
          <>
            {!findings.data.data.groups.length && (
              <p className="storage-muted">
                {t(detail.usage.latest_at ? 'storage.noGroups' : 'storage.needInventory')}
              </p>
            )}
            {findings.data.data.groups.map((g) => (
              <article className="storage-finding" key={g.gid}>
                <h5>
                  {t('storage.signal.' + g.kind + (g.bytes === null ? 'Unknown' : ''))} ·{' '}
                  {t('storage.copyCount', { count: g.copies })}
                </h5>
                <small>
                  {g.kind === 'verified' ? 'SHA-256' : t('storage.evidence')} ·{' '}
                  {g.kind === 'size' ? bytes(g.bytes) : g.val}
                  {g.kind !== 'size' && g.bytes !== null && <> · {bytes(g.bytes)}</>}
                </small>
                {g.kind === 'verified' && (
                  <p>
                    {t('storage.releasable')} · {bytes(g.potential_bytes)}
                    <br />
                    {t('storage.savings')} ·{' '}
                    {g.potential_monthly === null
                      ? t('storage.noRate')
                      : fmtMoney(g.potential_monthly, currency)}
                  </p>
                )}
                <Members group={g} />
                {!group && g.copies > g.members.length && (
                  <Button onClick={() => choose(g.gid)}>
                    {t('storage.allCopies')}
                  </Button>
                )}
              </article>
            ))}
            <Pager meta={findings.data.meta} change={setPage} />
            {!group && (
              <>
                <h4>{t('storage.nameClues')}</h4>
                {findings.data.data.names.length ? (
                  <ul className="storage-records">
                    {findings.data.data.names.map((n) => (
                      <li key={n.id}>
                        {n.name}{' '}
                        <small>
                          {n.account_name} · {n.region || '—'} · {Math.round(n.similarity * 100)}% ·{' '}
                          {n.services.join(' / ') || t('storage.alloc.unclaimed')}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="storage-muted">{t('storage.noNameClues')}</p>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}
