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
        <h2 className="text-xl font-semibold text-white">{t('s3Duplicates.title')}</h2>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {isFetching ? t('s3Duplicates.scanning') : t('s3Duplicates.scanNow')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('s3Duplicates.analysisFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : !analysis ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('s3Duplicates.noData')}
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500">{t('s3Duplicates.buckets')}</p>
              <p className="text-xl font-semibold text-white mt-1">{analysis.summary.bucket_count}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500">{t('s3Duplicates.similarPairs')}</p>
              <p className="text-xl font-semibold text-white mt-1">{analysis.summary.pair_count}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500">{t('s3Duplicates.duplicateGroups')}</p>
              <p className="text-xl font-semibold text-white mt-1">{analysis.summary.duplicate_group_count}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500">{t('s3Duplicates.potentialSavings')}</p>
              <p className="text-xl font-semibold text-green-400 mt-1">{fmt(analysis.summary.potential_savings)}</p>
            </div>
          </div>

          <div className="flex gap-1 mb-4 border-b border-gray-800">
            {(['groups', 'matrix', 'buckets'] as const).map((tb) => (
              <button
                key={tb}
                onClick={() => setTab(tb)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === tb
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {tb === 'groups' ? t('s3Duplicates.tabGroups') : tb === 'matrix' ? t('s3Duplicates.tabMatrix') : t('s3Duplicates.tabBuckets')}
              </button>
            ))}
          </div>

          {tab === 'groups' &&
            (analysis.duplicate_groups.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
                {t('s3Duplicates.noGroups')}
              </div>
            ) : (
              <div className="space-y-3">
                {analysis.duplicate_groups.map((g, i) => (
                  <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
                      <span className="text-sm font-semibold text-white">{t('s3Duplicates.groupN', { n: i + 1 })}</span>
                      <span className="text-xs text-yellow-300">
                        {t('s3Duplicates.redundantSummary', { count: g.redundant_count, cost: fmt(g.redundant_cost) })}
                      </span>
                    </div>
                    <table className="w-full text-left">
                      <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                        <tr>
                          <th className="px-4 py-2 font-medium">{t('s3Duplicates.colBucket')}</th>
                          <th className="px-4 py-2 font-medium">{t('cmdb.region')}</th>
                          <th className="px-4 py-2 font-medium">{t('s3Duplicates.colObjects')}</th>
                          <th className="px-4 py-2 font-medium">{t('s3Duplicates.colMonthlyCost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.buckets.map((b) => (
                          <tr key={b.id} className="border-b border-gray-700 last:border-0">
                            <td className="px-4 py-2 text-sm text-white font-mono">{b.name}</td>
                            <td className="px-4 py-2 text-sm text-gray-400">{b.region ?? '—'}</td>
                            <td className="px-4 py-2 text-sm text-gray-300">{b.object_count.toLocaleString()}</td>
                            <td className="px-4 py-2 text-sm text-gray-300">{fmt(b.total_cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))}

          {tab === 'matrix' &&
            (analysis.matrix.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
                {t('s3Duplicates.noPairs')}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
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
                        <tr key={i} className="border-b border-gray-700 last:border-0">
                          <td className="px-4 py-2 text-sm text-white font-mono">{p.bucket_a}</td>
                          <td className="px-4 py-2 text-sm text-white font-mono">{p.bucket_b}</td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <div className="w-32 h-2 bg-gray-800 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    p.similarity >= 0.8 ? 'bg-red-500' : p.similarity >= 0.5 ? 'bg-yellow-500' : 'bg-green-500'
                                  }`}
                                  style={{ width: `${p.similarity * 100}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-400">{(p.similarity * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))}

          {tab === 'buckets' && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('s3Duplicates.colBucket')}</th>
                    <th className="px-4 py-3 font-medium">{t('cmdb.region')}</th>
                    <th className="px-4 py-3 font-medium">{t('s3Duplicates.colObjects')}</th>
                    <th className="px-4 py-3 font-medium">{t('s3Duplicates.colMonthlyCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.buckets.map((b) => (
                    <tr key={b.id} className="border-b border-gray-700 last:border-0">
                      <td className="px-4 py-3 text-sm text-white font-mono">{b.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-400">{b.region ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-300">{b.object_count.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-gray-300">{fmt(b.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
