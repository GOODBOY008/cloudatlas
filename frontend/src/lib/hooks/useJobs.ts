import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { getJob, listJobs } from '../api'
import { isJobTerminal, type AccountJob } from '../../types'

/** Job effects span inventory, billing, dashboards, allocation and quality.
 * Invalidate only this workspace; retain other workspaces' cached data. */
function invalidateJobResults(queryClient: QueryClient, orgId: string) {
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(orgId) })
}

/**
 * Active jobs (pending + running) for the org — backs the layout indicator
 * and the per-account status chips. Polls fast (2 s) while jobs run and
 * slow (15 s) when idle (spec 2026-09-09 §5.1). When a job leaves the
 * active list (terminal transition), the page queries that reflect job
 * results are invalidated — replacing the old blind 4 s re-fetch.
 */
export function useActiveJobs(orgId: string | undefined) {
  const queryClient = useQueryClient()
  const prev = useRef<{ orgId: string | undefined; ids: Set<string> } | null>(null)

  const query = useQuery<AccountJob[], Error>({
    queryKey: ['jobs', 'active', orgId],
    enabled: !!orgId,
    queryFn: () => listJobs(orgId!, { active: true }),
    refetchInterval: (q) => (q.state.data?.length ? 2000 : 15000),
  })

  useEffect(() => {
    // An unresolved fetch is not evidence that jobs completed.
    if (!query.data || !orgId) return
    const ids = new Set(query.data.map((job) => job.id))
    if (prev.current?.orgId === orgId && [...prev.current.ids].some((id) => !ids.has(id))) {
      invalidateJobResults(queryClient, orgId)
    }
    prev.current = { orgId, ids }
  }, [query.data, orgId, queryClient])

  return query
}

/**
 * Single-job polling — the BillingImport progress card target. 2 s interval;
 * stops once terminal, and on the terminal transition invalidates the
 * active-jobs list plus the page queries that reflect job results.
 */
export function useJob(orgId: string | undefined, jobId: string | null) {
  const queryClient = useQueryClient()
  const prev = useRef<{ orgId: string; jobId: string; status: string } | null>(null)

  const query = useQuery<AccountJob, Error>({
    queryKey: ['jobs', 'detail', orgId, jobId],
    enabled: !!orgId && !!jobId,
    queryFn: () => getJob(orgId!, jobId!),
    refetchInterval: (q) => (q.state.data && isJobTerminal(q.state.data) ? false : 2000),
  })

  const status = query.data?.status ?? null
  useEffect(() => {
    if (!status || !orgId || !jobId) return
    const previous = prev.current
    if (isJobTerminal({ status }) && (previous?.orgId !== orgId || previous?.jobId !== jobId || previous?.status !== status)) {
      // Includes a job that finished before its first detail poll.
      invalidateJobResults(queryClient, orgId)
    }
    prev.current = { orgId, jobId, status }
  }, [status, orgId, jobId, queryClient])

  return query
}
