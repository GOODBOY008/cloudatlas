import type { TFunction } from 'i18next'

// Wire types for GET /orgs/{org}/cmdb/model-topology.
export interface ModelType {
  id: string
  name: string
  display_name: string
  classification: string | null
  is_builtin: boolean
  ci_count: number
}

export interface ModelEdge {
  id: string
  source: string
  target: string
  kind_name: string
  kind_display: string
  directed: boolean
  cardinality: string
}

export interface ModelGraph {
  nodes: ModelType[]
  edges: ModelEdge[]
}

export function typeLabel(node: ModelType, t: TFunction) {
  return node.is_builtin
    ? t(`modelTopology.types.${node.name}`, { defaultValue: node.display_name || node.name })
    : node.display_name || node.name
}

export function relationLabel(edge: ModelEdge, t: TFunction) {
  return t(`modelTopology.kinds.${edge.kind_name}`, { defaultValue: edge.kind_display || edge.kind_name })
}

export function defaultModel(graph: ModelGraph): ModelType | undefined {
  const cluster = graph.nodes.find(n => n.name === 'k8s_cluster' && n.is_builtin)
  if (cluster && cluster.ci_count > 0) return cluster
  const connected = new Set(graph.edges.flatMap(e => [e.source, e.target]))
  return graph.nodes.find(n => n.ci_count > 0 && connected.has(n.id))
    ?? graph.nodes.find(n => n.ci_count > 0) ?? cluster ?? graph.nodes[0]
}

// A linear component reads as a path. Branches, cycles, parallel definitions and
// self-relations keep their original endpoints in the relationship list.
export function modelComponent(nodes: Map<string, ModelType>, edges: ModelEdge[], focus: ModelType) {
  const adjacent = new Map<string, ModelEdge[]>()
  function add(id: string, edge: ModelEdge) {
    const list = adjacent.get(id)
    if (list) list.push(edge)
    else adjacent.set(id, [edge])
  }
  for (const edge of edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue
    add(edge.source, edge)
    if (edge.target !== edge.source) add(edge.target, edge)
  }
  const seen = new Set([focus.id])
  const component = new Set<ModelEdge>()
  const queue = [focus.id]
  for (const id of queue) {
    for (const edge of adjacent.get(id) ?? []) {
      component.add(edge)
      const next = edge.source === id ? edge.target : edge.source
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  const relations = [...component]
  const ends = queue.filter(id => adjacent.get(id)?.length === 1)
  const isPath = seen.size > 1 && seen.size <= 6 && ends.length === 2
    && relations.length === seen.size - 1 && queue.every(id => (adjacent.get(id)?.length ?? 0) <= 2)
  const path: { node: ModelType; edge?: ModelEdge }[] = []
  if (isPath) {
    // Prefer a source as the first node; use a stable tie-breaker for mixed directions.
    ends.sort((a, b) => {
      const outgoing = (id: string) => Number(adjacent.get(id)?.[0].source === id)
      return outgoing(b) - outgoing(a) || a.localeCompare(b)
    })
    let id = ends[0]
    let previous: ModelEdge | undefined
    while (true) {
      const edge = adjacent.get(id)?.find(e => e !== previous)
      path.push({ node: nodes.get(id)!, edge })
      if (!edge) break
      previous = edge
      id = edge.source === id ? edge.target : edge.source
    }
  }
  return { path, relations, size: seen.size }
}
