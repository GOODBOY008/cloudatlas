import { Table } from '@cloudflare/kumo/components/table'
import { Select } from '@cloudflare/kumo/components/select'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown, ArrowLeft, ArrowLeftRight, ArrowRight, Box, Boxes, CircleDollarSign, Cloud, Container,
  Database, FolderTree, Globe, HardDrive, Layers, List, Network, Server, Waypoints, Workflow,
} from 'lucide-react'
import api from '../lib/api'
import { defaultModel, modelComponent, relationLabel, typeLabel, type ModelEdge, type ModelGraph, type ModelType } from '../lib/modelTopology'
import { useOrgStore } from '../store/orgStore'
import type { CI, Organization } from '../types'
import { ModelInstances } from './ModelInstances'
import './modelTopology.css'

const icons = {
  k8s_cluster: Network, k8s_namespace: FolderTree, k8s_workload: Boxes, k8s_pod: Box, k8s_node: Server,
  cloud_instance: Server, cloud_bucket: Container, cloud_ip: Globe, cloud_lb: Waypoints, cloud_rds: Database,
  cloud_snapshot: Layers, cloud_volume: HardDrive, on_prem_server: Server, reserved_instance: Cloud,
  savings_plan: CircleDollarSign,
}

function TypeButton({ node, selected, onSelect }: { node: ModelType; selected: boolean; onSelect: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const Icon = node.is_builtin ? icons[node.name as keyof typeof icons] ?? Layers : Layers
  return <button type="button" className="model-type-card" aria-pressed={selected} onClick={() => onSelect(node.id)}>
    <Icon size={21} aria-hidden="true" />
    <span className="model-type-name">{typeLabel(node, t)}</span>
    <span className="model-type-count">{t('modelTopology.instances', { count: node.ci_count, value: node.ci_count.toLocaleString(i18n.language) })}</span>
  </button>
}

function Connector({ edge, reverse = false }: { edge: ModelEdge; reverse?: boolean }) {
  const { t } = useTranslation()
  const Arrow = !edge.directed ? ArrowLeftRight : reverse ? ArrowLeft : ArrowRight
  return <div className="model-connector">
    <span>{relationLabel(edge, t)}</span>
    <Arrow size={25} role="img" aria-label={t(!edge.directed ? 'modelTopology.symmetric' : reverse ? 'modelTopology.reverse' : 'modelTopology.directed')} />
    <small>{t(`modelTopology.cardinality.${edge.cardinality}`, { defaultValue: edge.cardinality })}</small>
  </div>
}

function ModelConnections({ edges, nodes, onSelect }: {
  edges: ModelEdge[]; nodes: Map<string, ModelType>; onSelect: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const ordered = [...edges].sort((a, b) => {
    const label = (edge: ModelEdge) => [typeLabel(nodes.get(edge.source)!, t), relationLabel(edge, t), typeLabel(nodes.get(edge.target)!, t)].join(' ')
    return label(a).localeCompare(label(b), i18n.language) || a.id.localeCompare(b.id)
  })
  return <Table className="model-relations-table">
    <caption className="sr-only">{t('modelTopology.definedRelations')}</caption>
    <Table.Header variant="compact"><Table.Row><th scope="col">{t('modelTopology.sourceType')}</th><th scope="col">{t('modelTopology.relation')}</th><th scope="col">{t('modelTopology.targetType')}</th></Table.Row></Table.Header>
    <Table.Body>{ordered.map(edge => {
      const Icon = edge.directed ? ArrowRight : ArrowLeftRight
      return <Table.Row key={edge.id}>
        <Table.Cell><button onClick={() => onSelect(edge.source)}>{typeLabel(nodes.get(edge.source)!, t)}</button></Table.Cell>
        <Table.Cell><span className="model-inline-verb">{relationLabel(edge, t)} <Icon size={16} role="img" aria-label={t(edge.directed ? 'modelTopology.directed' : 'modelTopology.symmetric')} /></span>
          <small>{t(`modelTopology.cardinality.${edge.cardinality}`, { defaultValue: edge.cardinality })}</small></Table.Cell>
        <Table.Cell><button onClick={() => onSelect(edge.target)}>{typeLabel(nodes.get(edge.target)!, t)}</button></Table.Cell>
      </Table.Row>
    })}</Table.Body>
  </Table>
}

function Explorer({ org, graph }: { org: Organization; graph: ModelGraph }) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [all, setAll] = useState(false)
  const requestedCi = params.get('ci')
  const detail = useQuery({
    queryKey: ['model-instance', org.id, requestedCi],
    enabled: !!requestedCi,
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }) => (await api.get<{ data: CI }>(`/orgs/${org.id}/cis/${encodeURIComponent(requestedCi!)}`, { signal })).data.data,
  })
  const nodes = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph.nodes])
  const edges = useMemo(() => graph.edges.filter(e => nodes.has(e.source) && nodes.has(e.target)), [graph.edges, nodes])
  const focus = nodes.get(detail.data?.ci_type_id ?? params.get('type') ?? '') ?? defaultModel(graph)
  const component = useMemo(() => focus ? modelComponent(nodes, edges, focus) : null, [nodes, edges, focus])
  function selectType(id: string) {
    setAll(false)
    setParams({ type: id }, { preventScrollReset: true })
  }
  if (!focus || !component) return <p className="model-notice">{t('modelTopology.noCiTypes')}</p>

  const groups = new Map<string, ModelType[]>()
  for (const node of nodes.values()) {
    const key = node.classification || 'other'
    const group = groups.get(key)
    if (group) group.push(node)
    else groups.set(key, [node])
  }
  const isContainerPath = !!component.path.length && component.path.every(({ node }) => node.is_builtin && node.name.startsWith('k8s_'))
  const direct = component.relations.filter(e => e.source === focus.id || e.target === focus.id)
  const directTypes = new Set([focus.id, ...direct.flatMap(e => [e.source, e.target])])
  const shownTypes = component.path.length ? component.size : directTypes.size
  const shownEdges = component.path.length ? component.relations.length : direct.length
  const countLabel = [t('modelTopology.typeTotal', { count: all ? nodes.size : shownTypes }),
    t('modelTopology.definitionTotal', { count: all ? edges.length : shownEdges })].join(' · ')
  const hint = <figcaption><span>{t('modelTopology.pathHint')}</span>
    <a href="#model-assets-heading">{t('modelTopology.jumpToAssets', { type: typeLabel(focus, t) })} <ArrowDown size={14} aria-hidden="true" /></a></figcaption>

  return <>
    <section className="model-panel" aria-labelledby="model-map-heading">
      <header className="model-panel-header">
        <div className="min-w-0">
          <h2 id="model-map-heading" className="model-heading"><Workflow size={20} aria-hidden="true" />
            {t(all ? 'modelTopology.definedRelations' : isContainerPath ? 'modelTopology.containerPath' : 'modelTopology.typeRelations')}
          </h2>
          <p className="model-meta">{countLabel}</p>
        </div>
        <div className="model-tools">
          <SelectField
            aria-label={t('modelTopology.selectType')}
            className="max-w-72"
            value={focus.id}
            onValueChange={selectType}
            items={graph.nodes.map(node => ({ value: node.id, label: typeLabel(node, t) }))}
          >
            {[...groups].map(([key, types]) => (
              <Select.Group key={key}>
                <Select.GroupLabel>{t(`modelTopology.groups.${key}`, { defaultValue: key })}</Select.GroupLabel>
                {types.map(node => <Select.Option key={node.id} value={node.id}>{typeLabel(node, t)}</Select.Option>)}
              </Select.Group>
            ))}
          </SelectField>
          <Button type="button" aria-pressed={all} onClick={() => setAll(!all)}>
            {all ? <Workflow size={15} /> : <List size={15} />}
            {t(all ? 'modelTopology.showMap' : 'modelTopology.showAll')}
          </Button>
        </div>
      </header>
      {all ? edges.length ? <ModelConnections edges={edges} nodes={nodes} onSelect={selectType} />
        : <p className="model-notice">{t('modelTopology.noDefinitions')}</p>
        : component.path.length ? <figure className="model-path-surface">
          <div className="model-path" aria-label={t('modelTopology.typeRelations')}>
            {component.path.map(({ node, edge }) => <Fragment key={node.id}>
                <TypeButton node={node} selected={node.id === focus.id} onSelect={selectType} />
                {edge && <Connector edge={edge} reverse={edge.source !== node.id} />}
              </Fragment>)}
          </div>
          {hint}
        </figure>
        : direct.length ? <figure className="model-path-surface">
          <ul className="model-branches">{direct.map(edge => <li key={edge.id} className="model-path">
            <TypeButton node={nodes.get(edge.source)!} selected={edge.source === focus.id} onSelect={selectType} />
            <Connector edge={edge} />
            <TypeButton node={nodes.get(edge.target)!} selected={edge.target === focus.id} onSelect={selectType} />
          </li>)}</ul>
          {hint}
        </figure>
        : <div className="model-isolated"><TypeButton node={focus} selected onSelect={selectType} />
          <p>{t('modelTopology.noTypeRelations', { type: typeLabel(focus, t) })}</p></div>}
    </section>

    {requestedCi && detail.isPending ? <p role="status" className="model-notice">{t('modelTopology.loadingInstance')}</p>
      : requestedCi && (detail.isError || !nodes.has(detail.data?.ci_type_id ?? '')) ? <div className="model-notice" role="alert">
        {t('modelTopology.instanceUnavailable')} <button className="text-accent" onClick={() => selectType(focus.id)}>{t('modelTopology.showInstances')}</button>
      </div>
      : <ModelInstances key={org.id + '/' + focus.id} org={org} model={focus} definitions={edges} requested={detail.data} />}
  </>
}

export default function ModelTopology() {
  const { t } = useTranslation()
  const org = useOrgStore(s => s.currentOrg)
  const graph = useQuery({
    queryKey: ['model-topology', org?.id],
    enabled: !!org,
    queryFn: async ({ signal }) => (await api.get<{ data: ModelGraph }>(`/orgs/${org!.id}/cmdb/model-topology`, { signal })).data.data,
  })
  return <div className="model-explorer">
    <header className="model-page-header">
      <div><h1 className="page-title">{t('modelTopology.title')}</h1><p>{t('modelTopology.subtitle')}</p></div>
      {org?.workspace && <Link to="/services" className="model-catalog-link">{t('modelTopology.serviceCatalog')} <ArrowRight size={15} aria-hidden="true" /></Link>}
    </header>
    {!org ? <p className="model-notice">{t('modelTopology.pickWorkspace')}</p>
      : graph.isPending ? <p role="status" className="model-notice">{t('modelTopology.loading')}</p>
      : graph.isError ? <div role="alert" className="model-notice">{t('modelTopology.loadFailed')} <button className="text-accent" onClick={() => graph.refetch()}>{t('modelTopology.retry')}</button></div>
      : <Explorer key={org.id} org={org} graph={graph.data} />}
  </div>
}
