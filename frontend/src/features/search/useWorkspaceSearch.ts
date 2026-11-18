import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'

export interface WorkspaceSearchResults {
  cis: Array<{ id: string; name: string; display_name: string }>
  resources: Array<{ id: string; name: string | null; resource_type: string | null; cost: number }>
  recommendations: Array<{ id: string; title: string; rec_type: string; savings: number }>
  services: Array<{ id: string; name: string; display_name: string }>
  pools: Array<{ id: string; name: string }>
}

export const EMPTY_RESULTS: WorkspaceSearchResults = {
  cis: [], resources: [], recommendations: [], services: [], pools: [],
}

/** Query identity includes the workspace and term; cancellation prevents stale results. */
export function useWorkspaceSearch(orgId: string | undefined, term: string, open: boolean) {
  const query = term.trim()
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    if (!open) { setDebounced(''); return }
    const timer = setTimeout(() => setDebounced(query), 200)
    return () => clearTimeout(timer)
  }, [query, open])
  const ready = open && !!orgId && query.length >= 2 && debounced === query
  const result = useQuery({
    queryKey: ['workspace-search', orgId, query],
    enabled: ready,
    queryFn: async ({ signal }) => {
      const response = await api.get<{ data: WorkspaceSearchResults }>(
        `/orgs/${orgId}/search`, { params: { q: query }, signal },
      )
      return response.data.data
    },
    retry: false,
    staleTime: 15_000,
  })
  return {
    results: ready ? result.data ?? EMPTY_RESULTS : EMPTY_RESULTS,
    loading: open && !!orgId && query.length >= 2 && (!ready || result.isPending),
    failed: ready && result.isError,
    retry: result.refetch,
  }
}
