import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Bucket {
  id: string
  name: string
  cloud_resource_id: string
  region: string | null
  total_cost: number
  object_count: number
  tags: Record<string, string>
}

interface MatrixPair {
  bucket_a: string
  bucket_b: string
  similarity: number
}

interface DupGroup {
  buckets: Bucket[]
  redundant_count: number
  redundant_cost: number
}

interface Analysis {
  buckets: Bucket[]
  matrix: MatrixPair[]
  duplicate_groups: DupGroup[]
  summary: {
    bucket_count: number
    pair_count: number
    duplicate_group_count: number
    potential_savings: number
  }
}

const fmt = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

export default function S3Duplicates() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [tab, setTab] = useState<'groups' | 'matrix' | 'buckets'>('groups')

  const { data: analysis, isLoading, isError, refetch, isFetching } = useQuery<Analysis>({
    queryKey: ['s3-duplicates', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Analysis }>(`/orgs/${orgId}/s3-duplicates`)
      return res.data
    },
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="page-title">{t('s3Duplicates.title')}</h2>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {isFetching ? t('s3Duplicates.scanning') : t('s3Duplicates.scanNow')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('s3Duplicates.analysisFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : !analysis ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('s3Duplicates.noData')}
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-surface border border-edge rounded-xl p-4">
              <p className="text-xs text-muted">{t('s3Duplicates.buckets')}</p>
              <p className="text-xl font-semibold text-primary mt-1">{analysis.summary.bucket_count}</p>
            </div>
            <div className="bg-surface border border-edge rounded-xl p-4">
              <p className="text-xs text-muted">{t('s3Duplicates.similarPairs')}</p>
              <p className="text-xl font-semibold text-primary mt-1">{analysis.summary.pair_count}</p>
            </div>
            <div className="bg-surface border border-edge rounded-xl p-4">
              <p className="text-xs text-muted">{t('s3Duplicates.duplicateGroups')}</p>
              <p className="text-xl font-semibold text-primary mt-1">{analysis.summary.duplicate_group_count}</p>
            </div>
            <div className="bg-surface border border-edge rounded-xl p-4">
              <p className="text-xs text-muted">{t('s3Duplicates.potentialSavings')}</p>
              <p className="text-xl font-semibold text-success mt-1">{fmt(analysis.summary.potential_savings)}</p>
            </div>
          </div>

          <div className="flex gap-1 mb-4 border-b border-edge">
            {(['groups', 'matrix', 'buckets'] as const).map((tb) => (
              <button
                key={tb}
                onClick={() => setTab(tb)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === tb
                    ? 'border-accent text-primary'
                    : 'border-transparent text-muted hover:text-secondary'
                }`}
              >
                {tb === 'groups' ? t('s3Duplicates.tabGroups') : tb === 'matrix' ? t('s3Duplicates.tabMatrix') : t('s3Duplicates.tabBuckets')}
              </button>
            ))}
          </div>

          {tab === 'groups' &&
            (analysis.duplicate_groups.length === 0 ? (
              <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
                {t('s3Duplicates.noGroups')}
              </div>
            ) : (
              <div className="space-y-3">
                {analysis.duplicate_groups.map((g, i) => (
                  <div key={i} className="bg-surface border border-edge rounded-xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
                      <span className="text-sm font-semibold text-primary">{t('s3Duplicates.groupN', { n: i + 1 })}</span>
                      <span className="text-xs text-warning">
                        {t('s3Duplicates.redundantSummary', { count: g.redundant_count, cost: fmt(g.redundant_cost) })}
                      </span>
                    </div>
                    <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
                      <thead className="border-b border-edge text-xs uppercase text-muted">
                        <tr>
                          <th className="px-4 py-2 font-medium">{t('s3Duplicates.colBucket')}</th>
                          <th className="px-4 py-2 font-medium">{t('cmdb.region')}</th>
                          <th className="px-4 py-2 font-medium">{t('s3Duplicates.colObjects')}</th>
                          <th className="px-4 py-2 font-medium">{t('s3Duplicates.colMonthlyCost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.buckets.map((b) => (
                          <tr key={b.id} className="border-b border-strong last:border-0">
                            <td className="px-4 py-2 text-sm text-primary font-mono">{b.name}</td>
                            <td className="px-4 py-2 text-sm text-secondary">{b.region ?? '—'}</td>
                            <td className="px-4 py-2 text-sm text-secondary">{b.object_count.toLocaleString()}</td>
                            <td className="px-4 py-2 text-sm text-secondary">{fmt(b.total_cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  </div>
                ))}
              </div>
            ))}

          {tab === 'matrix' &&
            (analysis.matrix.length === 0 ? (
              <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
                {t('s3Duplicates.noPairs')}
              </div>
            ) : (
              <div className="bg-surface border border-edge rounded-xl overflow-hidden">
                <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
                  <thead className="border-b border-edge text-xs uppercase text-muted">
                    <tr>
                      <th className="px-4 py-3 font-medium">{t('s3Duplicates.colBucketA')}</th>
                      <th className="px-4 py-3 font-medium">{t('s3Duplicates.colBucketB')}</th>
                      <th className="px-4 py-3 font-medium">{t('s3Duplicates.colSimilarity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.matrix
                      .slice()
                      .sort((a, b) => b.similarity - a.similarity)
                      .map((p, i) => (
                        <tr key={i} className="border-b border-strong last:border-0">
                          <td className="px-4 py-2 text-sm text-primary font-mono">{p.bucket_a}</td>
                          <td className="px-4 py-2 text-sm text-primary font-mono">{p.bucket_b}</td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <div className="w-32 h-2 bg-subtle rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    p.similarity >= 0.8 ? 'bg-danger-solid' : p.similarity >= 0.5 ? 'bg-warning-solid' : 'bg-success-solid'
                                  }`}
                                  style={{ width: `${p.similarity * 100}%` }}
                                />
                              </div>
                              <span className="text-xs text-secondary">{(p.similarity * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table></div>
              </div>
            ))}

          {tab === 'buckets' && (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div className="table-scroll" tabIndex={0}><table className="w-full text-left">
                <thead className="border-b border-edge text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('s3Duplicates.colBucket')}</th>
                    <th className="px-4 py-3 font-medium">{t('cmdb.region')}</th>
                    <th className="px-4 py-3 font-medium">{t('s3Duplicates.colObjects')}</th>
                    <th className="px-4 py-3 font-medium">{t('s3Duplicates.colMonthlyCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.buckets.map((b) => (
                    <tr key={b.id} className="border-b border-strong last:border-0">
                      <td className="px-4 py-3 text-sm text-primary font-mono">{b.name}</td>
                      <td className="px-4 py-3 text-sm text-secondary">{b.region ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-secondary">{b.object_count.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-secondary">{fmt(b.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
