import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getJob, listJobs } from '../api'
import { isJobTerminal, type AccountJob } from '../../types'

/**
 * Active jobs (pending + running) for the org — backs the layout indicator
 * and the per-account status chips. Polls fast (2 s) while jobs run and
 * slow (15 s) when idle (spec 2026-09-09 §5.1). When a job leaves the
 * active list (terminal transition), the page queries that reflect job
 * results are invalidated — replacing the old blind 4 s re-fetch.
 */
export function useActiveJobs(orgId: string | undefined) {
  const queryClient = useQueryClient()
  const prevIds = useRef<Set<string> | null>(null)

  const query = useQuery<AccountJob[], Error>({
    queryKey: ['jobs', 'active', orgId],
    enabled: !!orgId,
    queryFn: () => listJobs(orgId!, { active: true }),
    refetchInterval: (q) => (q.state.data?.length ? 2000 : 15000),
  })

  const currentIds = new Set((query.data ?? []).map((j) => j.id))
  useEffect(() => {
    if (prevIds.current) {
      for (const id of prevIds.current) {
        if (!currentIds.has(id)) {
          queryClient.invalidateQueries({ queryKey: ['jobs'] })
          queryClient.invalidateQueries({ queryKey: ['cloud-accounts', orgId] })
          queryClient.invalidateQueries({ queryKey: ['billing-history', orgId] })
          queryClient.invalidateQueries({ queryKey: ['expenses', orgId] })
          break
        }
      }
    }
    prevIds.current = currentIds
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
  const prevStatus = useRef<string | null>(null)

  const query = useQuery<AccountJob, Error>({
    queryKey: ['jobs', 'detail', orgId, jobId],
    enabled: !!orgId && !!jobId,
    queryFn: () => getJob(orgId!, jobId!),
    refetchInterval: (q) => (q.state.data && isJobTerminal(q.state.data) ? false : 2000),
  })

  const status = query.data?.status ?? null
  useEffect(() => {
    if (status && prevStatus.current && prevStatus.current !== status && isJobTerminal({ status })) {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['cloud-accounts', orgId] })
      queryClient.invalidateQueries({ queryKey: ['billing-history', orgId] })
      queryClient.invalidateQueries({ queryKey: ['expenses', orgId] })
    }
    prevStatus.current = status
  }, [status, orgId, queryClient])

  return query
}
