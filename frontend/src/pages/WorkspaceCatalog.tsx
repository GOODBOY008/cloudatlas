import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { isAxiosError } from 'axios'
import api from '../lib/api'
import { Modal } from '../components/shared/Modal'
import { CiPicker } from '../components/shared/CiPicker'
import type { Organization } from '../types'

interface Team { id: string; name: string }
interface CatalogService extends Team { team_id: string | null; system_name: string | null }
export interface Deployment {
  id: string
  name: string
  display_name?: string
  description?: string
  catalog_service_id: string | null
  is_default: boolean
  ci_count: number
}
interface CatalogData {
  teams: Team[]
  services: CatalogService[]
  deployments: Deployment[]
  can_edit_catalog: boolean
  can_edit_deployments: boolean
}
type Editor =
  | { kind: 'team'; value?: Team }
  | { kind: 'service'; value?: CatalogService }
  | { kind: 'bind'; service: CatalogService }
  | { kind: 'map'; deployment: Deployment }
  | { kind: 'delete'; resource: 'teams' | 'services'; value: Team }


export function WorkspaceCatalog({ org, openDeployment }: {
  org: Organization
  openDeployment: (deployment: Deployment, writable: boolean) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const url = `/orgs/${org.id}/catalog`
  const env = org.workspace?.environment
  const query = useQuery({
    queryKey: ['workspace-catalog', org.id],
    queryFn: async ({ signal }) => (await api.get<{ data: CatalogData }>(url, { signal })).data.data,
  })
  const [editor, setEditor] = useState<Editor | null>(null)
  const [name, setName] = useState('')
  const [team, setTeam] = useState('')
  const [system, setSystem] = useState('')
  const [deployment, setDeployment] = useState('')
  const [ci, setCi] = useState('')
  const [service, setService] = useState('')
  const data = query.data
  const mutation = useMutation({
    mutationFn: async (form: Editor) => {
      switch (form.kind) {
        case 'team':
          return form.value ? api.put(`${url}/teams/${form.value.id}`, { name }) : api.post(`${url}/teams`, { name })
        case 'service': {
          const body = { name, team_id: team || null, system_name: system || null }
          return form.value ? api.put(`${url}/services/${form.value.id}`, body) : api.post(`${url}/services`, body)
        }
        case 'bind':
          return api.post(`${url}/services/${form.service.id}/cis`, { ci_id: ci, deployment_id: deployment || null })
        case 'map':
          return api.put(`${url}/services/${service}/deployments/${form.deployment.id}`)
        case 'delete':
          return api.delete(`${url}/${form.resource}/${form.value.id}`)
      }
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['workspace-catalog'] })
      void client.invalidateQueries({ queryKey: ['service-cis', org.id] })
      void client.invalidateQueries({ queryKey: ['service-costs', org.id] })
      setEditor(null)
    },
  })

  function edit(form: Editor) {
    mutation.reset()
    setName('value' in form ? form.value?.name ?? '' : '')
    setTeam(form.kind === 'service' ? form.value?.team_id ?? '' : '')
    setSystem(form.kind === 'service' ? form.value?.system_name ?? '' : '')
    const deployments = form.kind === 'bind' ? data?.deployments.filter(d => d.catalog_service_id === form.service.id) : []
    setDeployment(deployments?.length === 1 && !deployments[0].is_default ? deployments[0].id : '')
    setCi('')
    setService('')
    setEditor(form)
  }

  function deploymentName(d: Deployment) {
    return d.is_default ? t('catalog.envDeployment', { env }) : d.display_name || d.name
  }

  if (query.isPending) return <p role="status" className="text-secondary">{t('common.loading')}</p>
  if (query.isError || !data) return <p role="alert" className="text-danger">{t('catalog.loadFailed')}</p>
  const { teams, services, deployments, can_edit_catalog: steward, can_edit_deployments: writable } = data
  const unmapped = deployments.filter(d => !d.catalog_service_id)
  const error = mutation.error
  const formTitle = editor?.kind === 'delete' ? t('catalog.deleteTitle', { name: editor.value.name })
    : editor?.kind === 'map' ? t('catalog.assignDeployment')
    : editor?.kind === 'bind' ? t('catalog.bind', { env })
    : editor?.kind === 'team' ? t(editor.value ? 'catalog.editTeam' : 'catalog.newTeam')
    : t(editor?.kind === 'service' && editor.value ? 'services.editService' : 'services.newService')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">{t('catalog.title')}</h1>
        <p className="mt-1 text-sm text-secondary">{t('catalog.scope', { workspace: org.workspace?.name, env })}</p>
      </header>
      <section className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-primary">{t('catalog.teams')}</h2>
          {steward && <Button onClick={() => edit({ kind: 'team' })}>{t('catalog.newTeam')}</Button>}
        </div>
        {teams.length === 0 && <p className="mt-2 text-sm text-muted">{t('catalog.noTeams')}</p>}
        <ul className="mt-2 divide-y divide-edge">{teams.map(item => <li key={item.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
          <span className="grow font-medium text-primary">{item.name}</span>
          {steward && <>
            <button className="text-accent" onClick={() => edit({ kind: 'team', value: item })}>{t('common.edit')}</button>
            <button className="text-danger" onClick={() => edit({ kind: 'delete', resource: 'teams', value: item })}>{t('common.delete')}</button>
          </>}
        </li>)}</ul>
      </section>
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-primary">{t('catalog.services')}</h2>
          {steward && <Button variant="primary" onClick={() => edit({ kind: 'service' })}>{t('services.newService')}</Button>}
        </div>
        {services.length === 0 && <p className="text-sm text-muted">{t('services.noServices')}</p>}
        {services.map(item => {
          const local = deployments.filter(d => d.catalog_service_id === item.id)
          return <article key={item.id} className="rounded-xl border border-edge bg-surface p-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <h3 className="grow font-semibold text-primary">{item.name}</h3>
              {steward && <>
                <button className="text-sm text-accent" onClick={() => edit({ kind: 'service', value: item })}>{t('common.edit')}</button>
                <button className="text-sm text-danger" onClick={() => edit({ kind: 'delete', resource: 'services', value: item })}>{t('common.delete')}</button>
              </>}
            </div>
            <dl className="my-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <div className="flex gap-2"><dt className="text-muted">{t('catalog.system')}</dt><dd>{item.system_name || '—'}</dd></div>
              <div className="flex gap-2"><dt className="text-muted">{t('services.ownerTeam')}</dt><dd>{teams.find(x => x.id === item.team_id)?.name || '—'}</dd></div>
            </dl>
            <Link className="text-sm text-accent" to={'/object-storage?service=' + item.id}>{t('storage.serviceBuckets')}</Link>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-3">
              <h4 className="text-sm font-medium text-secondary">{t('catalog.envDeployment', { env })}</h4>
              {writable && <Button onClick={() => edit({ kind: 'bind', service: item })}>{t('services.addCi')}</Button>}
            </div>
            {local.length === 0 && <p className="mt-2 text-sm text-muted">{t('catalog.noDeployment', { env })}</p>}
            <ul className="mt-2 space-y-2">{local.map(d => <li key={d.id}>
              <button className="flex w-full items-center justify-between gap-2 rounded-lg bg-subtle px-3 py-2 text-left text-sm hover:bg-emphasis" onClick={() => openDeployment({ ...d, display_name: deploymentName(d) }, writable)}>
                <span className="text-accent">{deploymentName(d)}</span><span className="shrink-0 text-secondary">{t('catalog.ciCount', { count: d.ci_count })}</span>
              </button>
            </li>)}</ul>
          </article>
        })}
      </section>
      {unmapped.length > 0 && <section className="rounded-xl border border-edge bg-surface p-4">
        <h2 className="font-semibold">{t('catalog.unassigned')}</h2>
        <ul>{unmapped.map(d => <li className="mt-2 flex flex-wrap justify-between gap-2 text-sm" key={d.id}>
          <button className="text-accent" onClick={() => openDeployment(d, writable)}>{deploymentName(d)}</button>
          {writable && <Button disabled={!services.length} onClick={() => edit({ kind: 'map', deployment: d })}>{t('catalog.assignDeployment')}</Button>}
        </li>)}</ul>
      </section>}
      {editor && <Modal title={formTitle} onClose={() => { if (!mutation.isPending) setEditor(null) }}>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (!mutation.isPending) mutation.mutate(editor) }}>
          {(editor.kind === 'team' || editor.kind === 'service') && <div>
            <Input label={t('catalog.name')} id="catalog-name" className="w-full" maxLength={160} required value={name} onChange={e => setName(e.target.value)} />
          </div>}
          {editor.kind === 'service' && <>
            <div><Input label={t('catalog.system')} id="catalog-system" className="w-full" maxLength={160} value={system} onChange={e => setSystem(e.target.value)} /></div>
            <div><SelectField
                label={t('services.ownerTeam')}
                id="catalog-team"
                className="w-full"
                value={team}
                onValueChange={setTeam}
                items={[
                  { value: "", label: t('catalog.unassignedTeam') },
                  ...teams.map(x => ({ value: x.id, label: x.name })),
                ]}
              /></div>
          </>}
          {editor.kind === 'bind' && <>
            <div><SelectField
                label={t('catalog.envDeployment', { env })}
                id="catalog-deployment"
                className="w-full"
                value={deployment}
                onValueChange={setDeployment}
                items={[
                  { value: "", label: t('catalog.defaultDeployment') },
                  ...deployments.filter(d => d.catalog_service_id === editor.service.id && !d.is_default).map(d => ({ value: d.id, label: deploymentName(d) })),
                ]}
              /></div>
            <CiPicker orgId={org.id} excludeIds={[]} value={ci} onChange={setCi} placeholder={t('services.selectCiPlaceholder')} />
          </>}
          {editor.kind === 'map' && <div><SelectField
              label={t('catalog.services')}
              id="catalog-service"
              className="w-full"
              required
              value={service}
              onValueChange={setService}
              items={[
                { value: "", label: "—" },
                ...services.map(x => ({ value: x.id, label: x.name })),
              ]}
            /></div>}
          {editor.kind === 'delete' && <p className="text-sm text-secondary">{t('catalog.deleteHint')}</p>}
          {error && <p role="alert" className="text-sm text-danger">{isAxiosError(error) && error.response?.status === 409 ? t('catalog.conflict') : t('catalog.saveFailed')}</p>}
          <div className="flex justify-end gap-2"><Button type="button" disabled={mutation.isPending} onClick={() => setEditor(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={mutation.isPending}>{editor.kind === 'delete' ? t('common.delete') : t('common.save')}</Button></div>
        </form>
      </Modal>}
    </div>
  )
}
