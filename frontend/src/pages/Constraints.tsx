import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { fmtMoney, useOrgCurrency } from '../lib/format'
import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

const CONSTRAINT_TYPES = ['expense_anomaly', 'resource_count', 'total_expense_limit', 'resource_tag_coverage']

const TYPE_HINTS: Record<string, string> = {
  expense_anomaly: 'constraints.hint.expenseAnomaly',
  resource_count: 'constraints.hint.resourceCount',
  total_expense_limit: 'constraints.hint.totalExpenseLimit',
  resource_tag_coverage: 'constraints.hint.tagCoverage',
}

interface Constraint {
  id: string
  name: string
  constraint_type: string
  filters: Record<string, unknown>
  limit_value: number | null
  is_active: boolean
  last_triggered_at: string | null
  created_at: string
}

interface Violation {
  constraint_id: string
  constraint_name: string
  constraint_type: string
  limit: number
  actual: number
  message: string
}

interface EvaluateResult {
  evaluated: number
  violations: Violation[]
}

interface ConstraintForm {
  name: string
  constraint_type: string
  limit_value: string
  threshold_factor: string
}

const DEFAULT_FORM: ConstraintForm = {
  name: '',
  constraint_type: 'expense_anomaly',
  limit_value: '',
  threshold_factor: '2.0',
}

function TypeBadge({ type }: { type: string }) {
  const { t } = useTranslation()
  const cls =
    type === 'expense_anomaly'
      ? 'bg-warning/10 text-warning'
      : type === 'resource_count'
        ? 'bg-info/10 text-info'
        : type === 'total_expense_limit'
          ? 'bg-danger/10 text-danger'
          : 'bg-violet/10 text-violet'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {t(`status.${type}`, { defaultValue: type })}
    </span>
  )
}

export default function Constraints() {
  const currency = useOrgCurrency()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ConstraintForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [evalResult, setEvalResult] = useState<EvaluateResult | null>(null)

  const { data: constraints = [], isLoading, isError } = useQuery<Constraint[]>({
    queryKey: ['constraints', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Constraint[] }>(`/orgs/${orgId}/constraints`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: unknown) => api.post(`/orgs/${orgId}/constraints`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['constraints', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('constraints.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: unknown }) =>
      api.put(`/orgs/${orgId}/constraints/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['constraints', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('constraints.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/constraints/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['constraints', orgId] }),
  })

  const evaluateMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/constraints/evaluate`),
    onSuccess: (res) => {
      setEvalResult((res.data as { data: EvaluateResult }).data)
      queryClient.invalidateQueries({ queryKey: ['constraints', orgId] })
    },
    onError: () => setEvalResult({ evaluated: 0, violations: [] }),
  })

  function openCreate() {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setShowModal(true)
  }

  function openEdit(c: Constraint) {
    setEditingId(c.id)
    setForm({
      name: c.name,
      constraint_type: c.constraint_type,
      limit_value: c.limit_value !== null ? String(c.limit_value) : '',
      threshold_factor:
        typeof c.filters?.threshold_factor === 'number'
          ? String(c.filters.threshold_factor)
          : '2.0',
    })
    setFormError('')
    setShowModal(true)
  }

  function closeModal() {
    setShowModal(false)
    setEditingId(null)
    setFormError('')
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.name.trim()) {
      setFormError(t('constraints.nameRequired'))
      return
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      constraint_type: form.constraint_type,
      limit_value: form.limit_value ? Number(form.limit_value) : undefined,
    }
    if (form.constraint_type === 'expense_anomaly' && form.threshold_factor) {
      payload.filters = { threshold_factor: Number(form.threshold_factor) }
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('constraints.title')}</h1>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => evaluateMutation.mutate()}
            disabled={evaluateMutation.isPending}
          >
            {evaluateMutation.isPending ? t('constraints.evaluating') : t('constraints.evaluateNow')}
          </Button>
          <Button
            variant="primary"
            onClick={openCreate}
          >
            {t('constraints.newConstraint')}
          </Button>
        </div>
      </div>

      {evalResult && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm ${
            evalResult.violations.length > 0
              ? 'bg-danger/10 border border-danger/25 text-danger'
              : 'bg-success/10 border border-success/25 text-success'
          }`}
        >
          {t('constraints.evalSummary', { count: evalResult.evaluated })} —{' '}
          {evalResult.violations.length === 0
            ? t('constraints.noViolations')
            : t('constraints.violationsDetected', { count: evalResult.violations.length })}
          {evalResult.violations.length > 0 && (
            <ul className="mt-2 space-y-1 list-disc list-inside">
              {evalResult.violations.map((v) => (
                <li key={v.constraint_id} className="text-xs">
                  <span className="font-medium">{v.constraint_name}</span>: {v.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('constraints.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : constraints.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('constraints.empty')}
        </div>
      ) : (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
            <Table.Header variant="compact" className="border-b border-edge">
              <Table.Row>
                <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('common.type')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('constraints.colLimit')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('common.active')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('constraints.colLastTriggered')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {constraints.map((c) => (
                <Table.Row key={c.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                  <Table.Cell className="px-4 py-3 text-sm text-primary">{c.name}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <TypeBadge type={c.constraint_type} />
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-sm font-mono text-secondary">
                    {c.constraint_type === 'expense_anomaly'
                      ? t('constraints.limitMultiplier', { factor: c.filters?.threshold_factor ?? 2.0 })
                      : c.limit_value !== null
                        ? c.constraint_type === 'resource_tag_coverage'
                          ? `${c.limit_value}%`
                          : fmtMoney(Number(c.limit_value), currency)
                        : '—'}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-sm text-secondary">{c.is_active ? '✓' : '✗'}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-xs text-muted">
                    {c.last_triggered_at ? new Date(c.last_triggered_at).toLocaleString() : t('common.never')}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <div className="flex items-center gap-3 text-xs">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm" variant="secondary-destructive"
                        onClick={() => {
                          if (confirm(t('constraints.deleteConfirm', { name: c.name }))) {
                            deleteMutation.mutate(c.id)
                          }
                        }}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={editingId ? t('constraints.editTitle') : t('constraints.newTitle')} onClose={closeModal}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">
              {editingId ? t('constraints.editTitle') : t('constraints.newTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input
                  label={t('common.name')}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full"
                  placeholder="prod-monthly-limit"
                />
              </div>
              <div>
                <SelectField
                  label={t('common.type')}
                  value={form.constraint_type}
                  onValueChange={value => setForm({ ...form, constraint_type: value })}
                  className="w-full"
                  items={CONSTRAINT_TYPES.map((type) => ({ value: type, label: t(`status.${type}`, { defaultValue: type }) }))}
                />
                <p className="text-xs text-muted mt-1">{t(TYPE_HINTS[form.constraint_type])}</p>
              </div>
              {form.constraint_type === 'expense_anomaly' ? (
                <div>
                  <Input
                    label={t('constraints.thresholdFactor')}
                    type="number"
                    step="0.1"
                    min="1"
                    value={form.threshold_factor}
                    onChange={(e) => setForm({ ...form, threshold_factor: e.target.value })}
                    className="w-full"
                  />
                </div>
              ) : (
                <div>
                  <Input
                    label={t('constraints.limitValue', { unit: form.constraint_type === 'resource_tag_coverage' ? '(%)' : '(' + currency + ')' })}
                    type="number"
                    step="0.01"
                    value={form.limit_value}
                    onChange={(e) => setForm({ ...form, limit_value: e.target.value })}
                    className="w-full"
                  />
                </div>
              )}
              {formError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={closeModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {editingId ? t('constraints.saveChanges') : t('constraints.createConstraint')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
