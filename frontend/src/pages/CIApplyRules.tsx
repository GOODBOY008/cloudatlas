import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Condition {
  field: string
  operator: string
  value: string
}

interface AttributePair {
  key: string
  value: string
}

interface CIApplyRule {
  id: string
  organization_id: string
  ci_type_id?: string
  ci_type_display?: string
  conditions: Condition[]
  attributes: Record<string, unknown>
  priority: number
  is_active: boolean
  applied_count: number
  created_at: string
  updated_at: string
}

interface CIType {
  id: string
  name: string
  display_name: string
}

interface ExecuteResult {
  applied: number
  skipped: number
  errors: string[]
}

const OPERATORS = ['eq', 'ne', 'contains', 'not_contains', 'gt', 'lt', 'gte', 'lte', 'starts_with', 'in']
const OPERATOR_SYMBOLS: Record<string, string> = {
  eq: '=', ne: '≠', gt: '>', lt: '<', gte: '≥', lte: '≤',
}
const COMMON_FIELDS = ['lifecycle_state', 'cloud_provider', 'cloud_region', 'name', 'ci_type_name']

export default function CIApplyRules() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  function operatorLabel(op: string): string {
    switch (op) {
      case 'contains': return t('ciApplyRules.opContains')
      case 'not_contains': return t('ciApplyRules.opNotContains')
      case 'starts_with': return t('ciApplyRules.opStartsWith')
      case 'in': return t('ciApplyRules.opIn')
      default: return OPERATOR_SYMBOLS[op] ?? op
    }
  }

  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')

  // Form state
  const [ciTypeId, setCiTypeId] = useState('')
  const [priority, setPriority] = useState(0)
  const [isActive, setIsActive] = useState(true)
  const [conditions, setConditions] = useState<Condition[]>([{ field: 'lifecycle_state', operator: 'eq', value: '' }])
  const [attributes, setAttributes] = useState<AttributePair[]>([{ key: '', value: '' }])

  // Execute result
  const [execResult, setExecResult] = useState<{ id: string; result: ExecuteResult } | null>(null)
  const [execLoading, setExecLoading] = useState<string | null>(null)

  const { data: rules = [], isLoading } = useQuery<CIApplyRule[]>({
    queryKey: ['ci-apply-rules', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIApplyRule[] }>(
        `/orgs/${orgId}/ci-apply-rules`
      )
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types-list', orgId],
    enabled: !!orgId && showForm,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  function resetForm() {
    setCiTypeId(''); setPriority(0); setIsActive(true)
    setConditions([{ field: 'lifecycle_state', operator: 'eq', value: '' }])
    setAttributes([{ key: '', value: '' }])
    setEditId(null); setFormError(''); setShowForm(false)
  }

  function buildPayload() {
    const cleanConds = conditions.filter(c => c.field.trim() && c.value.trim())
    const cleanAttrs: Record<string, string> = {}
    attributes.forEach(a => { if (a.key.trim()) cleanAttrs[a.key.trim()] = a.value })
    return {
      ci_type_id: ciTypeId || undefined,
      conditions: cleanConds,
      attributes: cleanAttrs,
      priority,
      is_active: isActive,
    }
  }

  const createMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/ci-apply-rules`, buildPayload()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-apply-rules', orgId] })
      resetForm()
    },
    onError: () => setFormError(t('ciApplyRules.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: () => api.put(`/orgs/${orgId}/ci-apply-rules/${editId}`, buildPayload()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-apply-rules', orgId] })
      resetForm()
    },
    onError: () => setFormError(t('ciApplyRules.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/ci-apply-rules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-apply-rules', orgId] }),
  })

  async function executeRule(id: string) {
    setExecLoading(id)
    try {
      const { data: res } = await api.post<{ data: ExecuteResult }>(
        `/orgs/${orgId}/ci-apply-rules/${id}/execute`, {}
      )
      setExecResult({ id, result: res.data })
      queryClient.invalidateQueries({ queryKey: ['ci-apply-rules', orgId] })
    } finally {
      setExecLoading(null)
    }
  }

  function startEdit(r: CIApplyRule) {
    setCiTypeId(r.ci_type_id ?? '')
    setPriority(r.priority)
    setIsActive(r.is_active)
    setConditions(r.conditions.length > 0 ? r.conditions : [{ field: '', operator: 'eq', value: '' }])
    const attrPairs = Object.entries(r.attributes).map(([k, v]) => ({ key: k, value: String(v) }))
    setAttributes(attrPairs.length > 0 ? attrPairs : [{ key: '', value: '' }])
    setEditId(r.id)
    setShowForm(true)
  }

  // Condition helpers
  function addCondition() {
    setConditions(prev => [...prev, { field: '', operator: 'eq', value: '' }])
  }
  function removeCondition(i: number) {
    setConditions(prev => prev.filter((_, idx) => idx !== i))
  }
  function updateCondition(i: number, key: keyof Condition, val: string) {
    setConditions(prev => prev.map((c, idx) => idx === i ? { ...c, [key]: val } : c))
  }

  // Attribute helpers
  function addAttribute() {
    setAttributes(prev => [...prev, { key: '', value: '' }])
  }
  function removeAttribute(i: number) {
    setAttributes(prev => prev.filter((_, idx) => idx !== i))
  }
  function updateAttribute(i: number, key: 'key' | 'value', val: string) {
    setAttributes(prev => prev.map((a, idx) => idx === i ? { ...a, [key]: val } : a))
  }

  const busy = createMutation.isPending || updateMutation.isPending

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">{t('ciApplyRules.title')}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {t('ciApplyRules.subtitle')}
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
        >
          {t('ciApplyRules.newRule')}
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-5">
          <h2 className="text-base font-semibold text-white">
            {editId ? t('ciApplyRules.editTitle') : t('ciApplyRules.newTitle')}
          </h2>
          {formError && <p className="text-red-400 text-sm">{formError}</p>}

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('ciApplyRules.ciTypeFilter')}</label>
              <select
                value={ciTypeId}
                onChange={e => setCiTypeId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              >
                <option value="">{t('ciApplyRules.anyCiType')}</option>
                {ciTypes.map(t => (
                  <option key={t.id} value={t.id}>{t.display_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('ciApplyRules.priorityLabel')}</label>
              <input
                type="number"
                value={priority}
                onChange={e => setPriority(Number(e.target.value))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-4 h-4" />
                <span className="text-sm text-gray-300">{t('common.active')}</span>
              </label>
            </div>
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-400">{t('ciApplyRules.conditionsLabel')}</label>
              <button
                onClick={addCondition}
                className="text-xs text-indigo-400 hover:text-indigo-300"
              >{t('ciApplyRules.addCondition')}</button>
            </div>
            <div className="space-y-2">
              {conditions.map((cond, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    list={`fields-list-${i}`}
                    value={cond.field}
                    onChange={e => updateCondition(i, 'field', e.target.value)}
                    placeholder={t('ciApplyRules.fieldPlaceholder')}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                  <datalist id={`fields-list-${i}`}>
                    {COMMON_FIELDS.map(f => <option key={f} value={f} />)}
                  </datalist>
                  <select
                    value={cond.operator}
                    onChange={e => updateCondition(i, 'operator', e.target.value)}
                    className="w-32 bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white"
                  >
                    {OPERATORS.map(op => (
                      <option key={op} value={op}>{operatorLabel(op)}</option>
                    ))}
                  </select>
                  <input
                    value={cond.value}
                    onChange={e => updateCondition(i, 'value', e.target.value)}
                    placeholder={t('ciApplyRules.valuePlaceholder')}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                  {conditions.length > 1 && (
                    <button onClick={() => removeCondition(i)} className="text-gray-600 hover:text-red-400 text-sm px-1">✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Attributes to apply */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-400">{t('ciApplyRules.attributesLabel')}</label>
              <button onClick={addAttribute} className="text-xs text-indigo-400 hover:text-indigo-300">{t('ciApplyRules.addField')}</button>
            </div>
            <div className="space-y-2">
              {attributes.map((attr, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={attr.key}
                    onChange={e => updateAttribute(i, 'key', e.target.value)}
                    placeholder={t('ciApplyRules.keyPlaceholder')}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                  <span className="text-gray-600">:</span>
                  <input
                    value={attr.value}
                    onChange={e => updateAttribute(i, 'value', e.target.value)}
                    placeholder={t('ciApplyRules.valuePlaceholder')}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                  {attributes.length > 1 && (
                    <button onClick={() => removeAttribute(i)} className="text-gray-600 hover:text-red-400 text-sm px-1">✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              disabled={busy}
              onClick={() => editId ? updateMutation.mutate() : createMutation.mutate()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
            >
              {busy ? t('ciApplyRules.saving') : editId ? t('ciApplyRules.updateRule') : t('ciApplyRules.createRule')}
            </button>
            <button onClick={resetForm} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Execute Result Banner */}
      {execResult && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">{t('ciApplyRules.execResult')}</h3>
            <button onClick={() => setExecResult(null)} className="text-gray-600 hover:text-gray-400 text-xs">✕</button>
          </div>
          <div className="flex gap-6">
            <span className="text-sm text-gray-400">{t('ciApplyRules.appliedLabel')} <span className="text-green-400 font-bold">{execResult.result.applied}</span></span>
            <span className="text-sm text-gray-400">{t('ciApplyRules.skippedLabel')} <span className="text-yellow-400 font-bold">{execResult.result.skipped}</span></span>
            <span className="text-sm text-gray-400">{t('ciApplyRules.errorsLabel')} <span className="text-red-400 font-bold">{execResult.result.errors.length}</span></span>
          </div>
          {execResult.result.errors.length > 0 && (
            <div className="text-xs text-red-400 space-y-0.5">
              {execResult.result.errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
        </div>
      )}

      {/* Rules Table */}
      {isLoading ? (
        <p className="text-gray-500 text-sm">{t('ciApplyRules.loading')}</p>
      ) : rules.length === 0 ? (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">⚙</p>
          <p className="text-sm">{t('ciApplyRules.empty')}</p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="text-left px-4 py-3">{t('cmdb.ciType')}</th>
                <th className="text-left px-4 py-3">{t('ciApplyRules.colConditions')}</th>
                <th className="text-left px-4 py-3">{t('ciApplyRules.colAttributes')}</th>
                <th className="text-center px-4 py-3">{t('ciApplyRules.colPriority')}</th>
                <th className="text-center px-4 py-3">{t('common.status')}</th>
                <th className="text-right px-4 py-3">{t('ciApplyRules.colApplied')}</th>
                <th className="text-right px-4 py-3">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id} className="border-b border-gray-800/60 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-gray-300 text-xs">
                    {r.ci_type_display ?? <span className="text-gray-600">{t('ciApplyRules.anyType')}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-0.5">
                      {r.conditions.slice(0, 2).map((c, i) => (
                        <div key={i} className="text-xs text-gray-400">
                          <span className="text-gray-300">{c.field}</span>
                          {' '}<span className="text-gray-600">{operatorLabel(c.operator)}</span>
                          {' '}<span className="text-indigo-300">"{c.value}"</span>
                        </div>
                      ))}
                      {r.conditions.length > 2 && (
                        <span className="text-xs text-gray-600">{t('ciApplyRules.more', { count: r.conditions.length - 2 })}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-0.5">
                      {Object.entries(r.attributes).slice(0, 2).map(([k, v]) => (
                        <div key={k} className="text-xs">
                          <span className="text-yellow-400">{k}</span>
                          <span className="text-gray-600">: </span>
                          <span className="text-gray-300">{String(v)}</span>
                        </div>
                      ))}
                      {Object.keys(r.attributes).length > 2 && (
                        <span className="text-xs text-gray-600">{t('ciApplyRules.more', { count: Object.keys(r.attributes).length - 2 })}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-400">{r.priority}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${r.is_active ? 'bg-green-900/40 text-green-300' : 'bg-gray-700 text-gray-500'}`}>
                      {r.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-indigo-400 font-medium">{r.applied_count}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        disabled={execLoading === r.id || !r.is_active}
                        onClick={() => executeRule(r.id)}
                        className="text-xs px-2 py-1 bg-green-800/40 hover:bg-green-700/50 text-green-300 rounded disabled:opacity-40"
                      >
                        {execLoading === r.id ? '…' : t('ciApplyRules.run')}
                      </button>
                      <button onClick={() => startEdit(r)} className="text-xs text-blue-400 hover:text-blue-300">{t('common.edit')}</button>
                      <button
                        onClick={() => { if (confirm(t('ciApplyRules.deleteRuleConfirm'))) deleteMutation.mutate(r.id) }}
                        className="text-xs text-red-400 hover:text-red-300"
                      >{t('common.delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
