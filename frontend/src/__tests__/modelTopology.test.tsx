import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import api from '../lib/api'
import { modelComponent, type ModelEdge, type ModelGraph, type ModelType } from '../lib/modelTopology'
import { useOrgStore } from '../store/orgStore'
import ModelTopology from '../pages/ModelTopology'

vi.mock('../lib/api', () => ({ default: { get: vi.fn() } }))
const get = vi.mocked(api.get)
const org = (id: 'pre' | 'prod') => ({ id, name: id, slug: id, workspace: { id: 'business', name: 'Business', environment: id } })
function model(name: string, count: number): ModelType {
  return { id: name, name, display_name: name, classification: 'container', is_builtin: true, ci_count: count }
}
function edge(id: string, source: string, target: string, directed = true): ModelEdge {
  return { id, source, target, directed, cardinality: 'one_to_many', kind_name: 'contains', kind_display: 'Contains' }
}
const cluster = model('k8s_cluster', 2)
const ns = model('k8s_namespace', 5)
const workload = model('k8s_workload', 3)
const isolated = { ...model('tenant_thing', 0), classification: 'Custom group', display_name: 'Custom asset', is_builtin: false }
const graph: ModelGraph = { nodes: [isolated, workload, ns, cluster], edges: [edge('b', ns.id, workload.id), edge('a', cluster.id, ns.id)] }
const asset = (id: string, name: string, type: string) => ({ id, name, display_name: name, ci_type_id: type, meta: {}, tags: {} })
const a = asset('c1', 'Cluster East', cluster.id)
const b = asset('n1', 'payments', ns.id)
const relation = { id: 'l1', src_ci_id: a.id, src_ci_name: a.name, dst_ci_id: b.id, dst_ci_name: b.name, association_kind_name: 'Contains' }
function page<T>(items: T[]) { return { data: { data: items, meta: { page: 1, total_pages: 1, per_page: 5, total: items.length } } } }

function show(url = '/model-topology') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ModelTopology /></MemoryRouter></QueryClientProvider>)
}
beforeEach(() => {
  useOrgStore.getState().setCurrentOrg(org('pre'))
  get.mockReset().mockImplementation(async (url, options) => {
    if (url.endsWith('/cmdb/model-topology')) return { data: { data: url.includes('/prod/') ? { ...graph, nodes: graph.nodes.map(n => ({ ...n, ci_count: 0 })) } : graph } }
    if (url === '/orgs/prod/cis') return page([])
    if (url === '/orgs/pre/cis') {
      const { ci_type_id, search } = (options?.params ?? {}) as { ci_type_id?: string; search?: string }
      return page([a, b].filter(ci => ci.ci_type_id === ci_type_id && (!search || ci.name.includes(search))))
    }
    if (url === '/orgs/pre/cis/n1') return { data: { data: b } }
    if (url === '/orgs/pre/cis/c1/associations' || url === '/orgs/pre/cis/n1/associations') return page([relation])
    throw new Error('Unavailable')
  })
})

describe('model topology explorer', () => {
  it('uses the API source/target contract and follows a real link in its stored direction', async () => {
    show()
    await screen.findByRole('heading', { name: 'Kubernetes type relationships' })
    const path = screen.getByLabelText('Type relationships')
    expect(within(path).getAllByRole('button').map(n => n.textContent)).toEqual(['Cluster2 instances', 'Namespace5 instances', 'Workload3 instances'])
    expect(within(path).getAllByText('Contains')).toHaveLength(2)
    await userEvent.click(await screen.findByRole('link', { name: 'Explore connections for payments' }))
    await screen.findByRole('heading', { name: 'Instances · Namespace' })
    const table = await screen.findByRole('table', { name: /Recorded connections.*payments/ })
    expect(within(table).getByRole('link', { name: 'Explore connections for Cluster East' }).closest('td')?.cellIndex).toBe(0)
    await userEvent.click(screen.getByRole('button', { name: 'Previous instance' }))
    await screen.findByRole('table', { name: /Recorded connections.*Cluster East/ })
    await userEvent.click(screen.getByRole('button', { name: 'All relationships' }))
    const definitions = screen.getByRole('table', { name: 'All model relationships' })
    expect(within(definitions).getAllByRole('row')).toHaveLength(3)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Asset type' }), isolated.id)
    expect(await screen.findByText('No model relationships are defined for Custom asset.')).toBeInTheDocument()
    expect(await screen.findByText('There are no instances of this type in this environment.')).toBeInTheDocument()
  })

  it('clears pre instances and links when switching to an environment with only model definitions', async () => {
    show()
    await screen.findByRole('link', { name: 'Explore connections for payments' })
    act(() => useOrgStore.getState().setCurrentOrg(org('prod')))
    expect(await screen.findByText('There are no instances of this type in this environment.')).toBeInTheDocument()
    expect(screen.queryByText('Cluster East')).not.toBeInTheDocument()
    expect(screen.queryByText('payments')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Kubernetes type relationships' })).toBeInTheDocument()
    expect(get.mock.calls.some(([url]) => url.startsWith('/orgs/prod/cis/c1'))).toBe(false)
  })

  it('reports a failed relation request separately from an asset with zero links', async () => {
    const serve = get.getMockImplementation()!
    get.mockImplementation((url, options) => url.endsWith('/associations') ? Promise.reject(new Error('Unavailable')) : serve(url, options))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recorded connections')
    expect(screen.queryByText('No direct connections are recorded for this instance.')).not.toBeInTheDocument()
  })

  it('does not flatten branches, cycles, self-links or parallel definitions into a false path', () => {
    const nodes = new Map(graph.nodes.map(n => [n.id, n]))
    for (const extra of [edge('branch', ns.id, isolated.id), edge('cycle', workload.id, cluster.id),
      edge('self', ns.id, ns.id), edge('parallel', ns.id, cluster.id, false)]) {
      const component = modelComponent(nodes, [...graph.edges, extra, edge('dangling', cluster.id, 'outside')], cluster)
      expect(component.path).toEqual([])
      expect(component.relations.map(e => e.id).sort()).toEqual(['a', 'b', extra.id].sort())
    }
  })
})
