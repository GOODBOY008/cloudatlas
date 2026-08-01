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
      ? 'bg-yellow-900/40 text-yellow-300'
      : type === 'resource_count'
        ? 'bg-blue-900/40 text-blue-300'
        : type === 'total_expense_limit'
          ? 'bg-red-900/40 text-red-300'
          : 'bg-purple-900/40 text-purple-300'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {t(`status.${type}`, { defaultValue: type })}
    </span>
  )
}

export default function Constraints() {
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

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('constraints.title')}</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => evaluateMutation.mutate()}
            disabled={evaluateMutation.isPending}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {evaluateMutation.isPending ? t('constraints.evaluating') : t('constraints.evaluateNow')}
          </button>
          <button
            onClick={openCreate}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {t('constraints.newConstraint')}
          </button>
        </div>
      </div>

      {evalResult && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm ${
            evalResult.violations.length > 0
              ? 'bg-red-900/40 border border-red-700 text-red-400'
              : 'bg-green-900/40 border border-green-700 text-green-400'
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
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('constraints.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : constraints.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('constraints.empty')}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                <th className="px-4 py-3 font-medium">{t('common.type')}</th>
                <th className="px-4 py-3 font-medium">{t('constraints.colLimit')}</th>
                <th className="px-4 py-3 font-medium">{t('common.active')}</th>
                <th className="px-4 py-3 font-medium">{t('constraints.colLastTriggered')}</th>
                <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {constraints.map((c) => (
                <tr key={c.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 text-sm text-white">{c.name}</td>
                  <td className="px-4 py-3">
                    <TypeBadge type={c.constraint_type} />
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-300">
                    {c.constraint_type === 'expense_anomaly'
                      ? t('constraints.limitMultiplier', { factor: c.filters?.threshold_factor ?? 2.0 })
                      : c.limit_value !== null
                        ? c.constraint_type === 'resource_tag_coverage'
                          ? `${c.limit_value}%`
                          : `$${Number(c.limit_value).toLocaleString()}`
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">{c.is_active ? '✓' : '✗'}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {c.last_triggered_at ? new Date(c.last_triggered_at).toLocaleString() : t('common.never')}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 text-xs">
                      <button onClick={() => openEdit(c)} className="text-indigo-400 hover:text-indigo-300">
                        {t('common.edit')}
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(t('constraints.deleteConfirm', { name: c.name }))) {
                            deleteMutation.mutate(c.id)
                          }
                        }}
                        className="text-red-400 hover:text-red-300"
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={closeModal}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? t('constraints.editTitle') : t('constraints.newTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                  placeholder="prod-monthly-limit"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.type')}</label>
                <select
                  value={form.constraint_type}
                  onChange={(e) => setForm({ ...form, constraint_type: e.target.value })}
                  className={inputCls}
                >
                  {CONSTRAINT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`status.${type}`, { defaultValue: type })}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-600 mt-1">{t(TYPE_HINTS[form.constraint_type])}</p>
              </div>
              {form.constraint_type === 'expense_anomaly' ? (
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    {t('constraints.thresholdFactor')}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    value={form.threshold_factor}
                    onChange={(e) => setForm({ ...form, threshold_factor: e.target.value })}
                    className={inputCls}
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    {t('constraints.limitValue', { unit: form.constraint_type === 'resource_tag_coverage' ? '(%)' : '(USD)' })}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.limit_value}
                    onChange={(e) => setForm({ ...form, limit_value: e.target.value })}
                    className={inputCls}
                  />
                </div>
              )}
              {formError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {editingId ? t('constraints.saveChanges') : t('constraints.createConstraint')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
