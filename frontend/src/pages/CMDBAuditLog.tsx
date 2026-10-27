import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'

interface AuditLog {
  id: string
  ci_id: string | null
  ci_name: string | null
  ci_type_name: string | null
  resource_type?: string
  resource_name?: string | null
  operation: string
  user_id?: string
  user_email?: string
  field_changes?: Record<string, { from: unknown; to: unknown }>
  meta?: Record<string, unknown>
  created_at: string
}

const OPERATIONS = [
  'create',
  'update',
  'delete',
  'lifecycle_transition',
  'drift',
  'compliance_check',
  'bulk_import',
  'add_ci',
  'remove_ci',
  'create_unique_constraint',
  'delete_unique_constraint',
]

/** T4: audit targets — CI instances plus model-layer resources. */
const RESOURCE_TYPES = [
  'ci',
  'ci_type',
  'ci_attribute',
  'ci_classification',
  'ci_association_kind',
  'ci_object_association',
  'service',
  'service_template',
  'field_template',
]

const OPERATION_COLORS: Record<string, string> = {
  create: 'bg-success/10 text-success',
  update: 'bg-info/10 text-info',
  delete: 'bg-danger/10 text-danger',
  drift: 'bg-warning/10 text-warning',
  compliance_check: 'bg-violet/10 text-violet',
  bulk_import: 'bg-accent/10 text-accent',
}

function formatDate(ts: string) {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function FieldChangesCell({ changes }: { changes?: Record<string, { from: unknown; to: unknown }> }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  if (!changes || Object.keys(changes).length === 0) {
    return <span className="text-muted text-xs">—</span>
  }
  const entries = Object.entries(changes)
  return (
    <div>
      <button
        onClick={() => setExpanded(e => !e)}
        className="text-xs text-accent hover:text-accent"
      >
        {expanded ? '▼' : '▶'} {t(entries.length === 1 ? 'cmdbAuditLog.fieldCountSingle' : 'cmdbAuditLog.fieldCountPlural', { count: entries.length })}
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-2 border-l-2 border-strong">
          {entries.map(([field, { from, to }]) => (
            <div key={field} className="text-xs">
              <span className="text-secondary">{field}: </span>
              <span className="text-danger line-through">{String(from ?? '—')}</span>
              <span className="text-muted"> → </span>
              <span className="text-success">{String(to ?? '—')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CMDBAuditLog() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [filterOp, setFilterOp] = useState('')
  const [filterResource, setFilterResource] = useState('')
  const [filterCIName, setFilterCIName] = useState('')
  const [inputCIName, setInputCIName] = useState('')

  const { query, rows: logs, page, perPage, totalPages, total, setPage, setPerPage } =
    usePagination<AuditLog>(
      ['cmdb-audit-logs', orgId, filterOp, filterResource, filterCIName],
      (p, pp) =>
        paginatedGet<AuditLog>(`/orgs/${orgId}/cmdb/audit-logs`, {
          page: p,
          per_page: pp,
          ...(filterOp ? { operation: filterOp } : {}),
          ...(filterResource ? { resource_type: filterResource } : {}),
        }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const { isLoading, isFetching } = query

  function applySearch() {
    setFilterCIName(inputCIName)
  }

  function clearFilters() {
    setFilterOp('')
    setFilterResource('')
    setFilterCIName('')
    setInputCIName('')
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">{t('cmdbAuditLog.title')}</h1>
        <p className="text-sm text-secondary mt-0.5">
          {t('cmdbAuditLog.subtitle')}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-secondary mb-1">{t('cmdbAuditLog.operation')}</label>
          <select
            value={filterOp}
            onChange={e => setFilterOp(e.target.value)}
            className="bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary"
          >
            <option value="">{t('cmdbAuditLog.allOperations')}</option>
            {OPERATIONS.map(op => (
              <option key={op} value={op}>{t(`cmdbAuditLog.op.${op}`, { defaultValue: op })}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-secondary mb-1">{t('cmdbAuditLog.resourceType')}</label>
          <select
            value={filterResource}
            onChange={e => setFilterResource(e.target.value)}
            className="bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary"
          >
            <option value="">{t('cmdbAuditLog.allResourceTypes')}</option>
            {RESOURCE_TYPES.map(rt => (
              <option key={rt} value={rt}>{t(`cmdbAuditLog.resource.${rt}`, { defaultValue: rt })}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-secondary mb-1">{t('cmdbAuditLog.colCiName')}</label>
          <div className="flex gap-2">
            <input
              value={inputCIName}
              onChange={e => setInputCIName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applySearch()}
              placeholder={t('cmdbAuditLog.searchPlaceholder')}
              className="bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary"
            />
            <button
              onClick={applySearch}
              className="px-3 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-lg"
            >{t('common.search')}</button>
          </div>
        </div>
        {(filterOp || filterResource || filterCIName) && (
          <button
            onClick={clearFilters}
            className="text-xs text-secondary hover:text-primary self-end pb-2"
          >
            {t('cmdbAuditLog.clearFilters')}
          </button>
        )}
      </div>

      {/* Stats bar */}
      {!isLoading && (
        <div className="flex items-center gap-4 text-xs text-muted">
          <span>{t(total === 1 ? 'cmdbAuditLog.totalEventsSingle' : 'cmdbAuditLog.totalEventsPlural', { count: total })}</span>
          {isFetching && <span className="text-accent">{t('cmdbAuditLog.refreshing')}</span>}
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <p className="text-muted text-sm">{t('cmdbAuditLog.loading')}</p>
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-16 text-muted">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm">{filterOp || filterResource || filterCIName ? t('cmdbAuditLog.noEventsFiltered') : t('cmdbAuditLog.noEvents')}</p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-edge overflow-hidden">
          <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-edge">
                <th className="text-left px-4 py-3">{t('cmdbAuditLog.colCiName')}</th>
                <th className="text-left px-4 py-3">{t('cmdb.ciType')}</th>
                <th className="text-left px-4 py-3">{t('cmdbAuditLog.operation')}</th>
                <th className="text-left px-4 py-3">{t('cmdbAuditLog.colUser')}</th>
                <th className="text-left px-4 py-3">{t('cmdbAuditLog.colChanges')}</th>
                <th className="text-right px-4 py-3">{t('cmdbAuditLog.colTime')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-b border-edge/40 hover:bg-subtle/30">
                  <td className="px-4 py-3 text-primary">
                    {log.ci_name ?? log.resource_name ?? '—'}
                    {log.resource_type && log.resource_type !== 'ci' && (
                      <span className="ml-2 px-1.5 py-0.5 bg-emphasis text-secondary text-xs rounded">
                        {t(`cmdbAuditLog.resource.${log.resource_type}`, { defaultValue: log.resource_type })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-secondary text-xs">{log.ci_type_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${OPERATION_COLORS[log.operation] ?? 'bg-emphasis text-secondary'}`}>
                      {t(`cmdbAuditLog.op.${log.operation}`, { defaultValue: log.operation })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-secondary text-xs">{log.user_email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <FieldChangesCell changes={log.field_changes} />
                  </td>
                  <td className="px-4 py-3 text-right text-muted text-xs whitespace-nowrap">
                    {formatDate(log.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {/* Pagination */}
      <PaginationBar
        page={page}
        totalPages={totalPages}
        total={total}
        perPage={perPage}
        onPageChange={setPage}
        onPerPageChange={setPerPage}
      />
    </div>
  )
}
