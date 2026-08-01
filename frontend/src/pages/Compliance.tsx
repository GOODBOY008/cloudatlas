import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface ComplianceRule {
  field: string
  op: string
  value?: unknown
}

interface RuleForm {
  field: string
  op: string
  value: string
}

interface CompliancePolicy {
  id: string
  name: string
  description?: string
  ci_type_id?: string
  rules: ComplianceRule[]
  severity?: string
  is_active: boolean
  created_at: string
  target_type?: string
  target_group_id?: string | null
}

interface ComplianceResult {
  id: string
  ci_id: string
  ci_name: string
  policy_id: string
  policy_name: string
  status?: string
  details?: unknown
  checked_at: string
}

interface CheckSummary {
  status: 'compliant' | 'non_compliant'
  checked: number
  compliant: number
  non_compliant: number
  message?: string
}

const RULE_OPS: Array<{ value: string; needsValue: boolean }> = [
  { value: 'exists', needsValue: false },
  { value: 'not_exists', needsValue: false },
  { value: 'eq', needsValue: true },
  { value: 'ne', needsValue: true },
  { value: 'in', needsValue: true },
  { value: 'contains', needsValue: true },
  { value: 'gte', needsValue: true },
  { value: 'lte', needsValue: true },
]

const opNeedsValue = (op: string) => RULE_OPS.find(o => o.value === op)?.needsValue ?? false

const DEFAULT_RULE: RuleForm = { field: '', op: 'exists', value: '' }

function toRuleForms(rules: unknown): RuleForm[] {
  if (!Array.isArray(rules) || rules.length === 0) return [{ ...DEFAULT_RULE }]
  return rules.map(r => {
    const o = (r ?? {}) as Partial<ComplianceRule>
    const v = o.value
    const value = Array.isArray(v)
      ? v.map(String).join(', ')
      : v === undefined || v === null
        ? ''
        : String(v)
    return {
      field: typeof o.field === 'string' ? o.field : '',
      op: typeof o.op === 'string' && RULE_OPS.some(x => x.value === o.op) ? o.op : 'exists',
      value,
    }
  })
}

function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: { message?: string } } } }
  return e?.response?.data?.error?.message ?? fallback
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-900/40 text-red-300',
  high: 'bg-orange-900/40 text-orange-300',
  medium: 'bg-yellow-900/40 text-yellow-300',
  low: 'bg-gray-700 text-gray-400',
  info: 'bg-blue-900/40 text-blue-300',
}

const STATUS_COLORS: Record<string, string> = {
  compliant: 'text-green-300',
  non_compliant: 'text-red-400',
  unknown: 'text-gray-500',
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

export default function Compliance() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [policyName, setPolicyName] = useState('')
  const [policyDesc, setPolicyDesc] = useState('')
  const [severity, setSeverity] = useState('medium')
  // T16: policy targeting — all | ci_type | dynamic_group.
  const [targetType, setTargetType] = useState<'all' | 'ci_type' | 'dynamic_group'>('all')
  const [targetTypeId, setTargetTypeId] = useState('')
  const [targetGroupId, setTargetGroupId] = useState('')
  const [rules, setRules] = useState<RuleForm[]>([{ ...DEFAULT_RULE }])
  const [activeTab, setActiveTab] = useState<'policies' | 'results'>('policies')
  const [checkResult, setCheckResult] = useState<CheckSummary | null>(null)

  const { data: policies = [], isLoading: loadingPolicies } = useQuery<CompliancePolicy[]>({
    queryKey: ['compliance-policies', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CompliancePolicy[] }>(
        `/orgs/${orgId}/compliance-policies`
      )
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<Array<{ id: string; display_name: string }>>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId && showForm,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; display_name: string }> }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const { data: dynGroups = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['ci-groups', orgId],
    enabled: !!orgId && showForm,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; name: string }> }>(`/orgs/${orgId}/ci-groups`)
      return res.data ?? []
    },
  })

  const { data: results = [], isLoading: loadingResults } = useQuery<ComplianceResult[]>({
    queryKey: ['compliance-results', orgId],
    enabled: !!orgId && activeTab === 'results',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ComplianceResult[] }>(
        `/orgs/${orgId}/compliance/results`
      )
      return res.data ?? []
    },
  })

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
    setFormError('')
  }

  const openCreate = () => {
    setEditingId(null)
    setPolicyName('')
    setPolicyDesc('')
    setSeverity('medium')
    setTargetType('all')
    setTargetTypeId('')
    setTargetGroupId('')
    setRules([{ ...DEFAULT_RULE }])
    setFormError('')
    setShowForm(true)
  }

  const openEdit = (p: CompliancePolicy) => {
    setEditingId(p.id)
    setPolicyName(p.name)
    setPolicyDesc(p.description ?? '')
    setSeverity(p.severity ?? 'medium')
    const tt = (p.target_type ?? (p.ci_type_id ? 'ci_type' : 'all')) as 'all' | 'ci_type' | 'dynamic_group'
    setTargetType(tt)
    setTargetTypeId(p.ci_type_id ?? '')
    setTargetGroupId(p.target_group_id ?? '')
    setRules(toRuleForms(p.rules))
    setFormError('')
    setShowForm(true)
  }

  const buildPayload = (): Record<string, unknown> | null => {
    if (rules.length === 0) {
      setFormError(t('compliance.atLeastOneRule'))
      return null
    }
    const serialized: Array<Record<string, unknown>> = []
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      const field = r.field.trim()
      if (!field) {
        setFormError(`${t('compliance.ruleFieldRequired')} (#${i + 1})`)
        return null
      }
      const rule: Record<string, unknown> = { field, op: r.op }
      if (opNeedsValue(r.op)) {
        const trimmed = r.value.trim()
        if (!trimmed) {
          setFormError(`${t('compliance.ruleValueRequired')} (#${i + 1})`)
          return null
        }
        rule.value =
          r.op === 'in'
            ? trimmed.split(',').map(v => v.trim()).filter(Boolean)
            : r.op === 'gte' || r.op === 'lte'
              ? Number.isNaN(Number(trimmed)) ? trimmed : Number(trimmed)
              : trimmed
      }
      serialized.push(rule)
    }
    const target: Record<string, unknown> = {}
    if (targetType === 'ci_type' && targetTypeId) {
      target.ci_type_id = targetTypeId
      target.target_type = 'ci_type'
    } else if (targetType === 'dynamic_group' && targetGroupId) {
      target.target_type = 'dynamic_group'
      target.target_group_id = targetGroupId
    }
    return {
      name: policyName.trim(),
      description: policyDesc.trim() || undefined,
      severity,
      rules: serialized,
      ...target,
    }
  }

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post(`/orgs/${orgId}/compliance-policies`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] })
      closeForm()
    },
    onError: err => setFormError(apiErrorMessage(err, t('compliance.createFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.put(`/orgs/${orgId}/compliance-policies/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] })
      closeForm()
    },
    onError: err => setFormError(apiErrorMessage(err, t('compliance.updateFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/compliance-policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] }),
  })

  const toggleMutation = useMutation({
    mutationFn: (p: CompliancePolicy) =>
      api.put(`/orgs/${orgId}/compliance-policies/${p.id}`, { is_active: !p.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] }),
  })

  const runCheckMutation = useMutation({
    mutationFn: () => api.post<{ data: CheckSummary }>(`/orgs/${orgId}/compliance/run`, {}),
    onSuccess: res => {
      setCheckResult(res.data.data)
      queryClient.invalidateQueries({ queryKey: ['compliance-results', orgId] })
      setActiveTab('results')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!policyName.trim()) { setFormError(t('compliance.nameRequired')); return }
    const payload = buildPayload()
    if (!payload) return
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const updateRule = (i: number, patch: Partial<RuleForm>) => {
    setRules(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const violationText = (v: unknown): string => {
    const o = (v ?? {}) as ComplianceRule
    const field = typeof o.field === 'string' ? o.field : '?'
    const opLabel = t(`compliance.op.${o.op}`, { defaultValue: o.op ?? '' })
    const val = Array.isArray(o.value)
      ? o.value.map(String).join(', ')
      : o.value === undefined || o.value === null
        ? ''
        : String(o.value)
    return val ? `${field} ${opLabel} ${val}` : `${field} ${opLabel}`
  }

  const inputCls =
    'w-full bg-gray-700 text-gray-200 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:border-indigo-500'

  // T12: latest compliance run (manual or scheduled).
  const { data: lastRun } = useQuery<{ status?: string; started_at?: string; result?: { trigger?: string } } | null>({
    queryKey: ['compliance-last-run', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: null | { status?: string; started_at?: string; result?: { trigger?: string } } }>(
        `/orgs/${orgId}/compliance/last-run`
      )
      return res.data ?? null
    },
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('compliance.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('compliance.subtitle')}</p>
          {lastRun?.started_at && (
            <p className="text-xs text-gray-500 mt-1 flex items-center gap-2" data-testid="compliance-last-run">
              <span className="px-1.5 py-0.5 bg-purple-900/40 text-purple-300 rounded text-xs">
                {t('compliance.scheduledBadge')}
              </span>
              {t('compliance.lastRun', {
                time: new Date(lastRun.started_at).toLocaleString(),
                trigger: t(`compliance.trigger.${lastRun.result?.trigger ?? 'manual'}`, { defaultValue: lastRun.result?.trigger ?? 'manual' }),
              })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => runCheckMutation.mutate()}
            disabled={runCheckMutation.isPending}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            {runCheckMutation.isPending ? t('compliance.checking') : t('compliance.runCheck')}
          </button>
          <button
            onClick={showForm ? closeForm : openCreate}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors"
          >
            {showForm ? t('common.cancel') : t('compliance.newPolicy')}
          </button>
        </div>
      </div>

      {/* Check result banner */}
      {checkResult && (
        <div className={`rounded-xl p-4 mb-5 flex items-center gap-4 ${
          checkResult.status === 'compliant'
            ? 'bg-green-900/30 border border-green-800'
            : 'bg-red-900/30 border border-red-800'
        }`}>
          <span className="text-2xl">{checkResult.status === 'compliant' ? '✅' : '⚠️'}</span>
          <div>
            <p className="text-white font-medium">
              {t(`status.${checkResult.status}`)}
            </p>
            <p className="text-sm text-gray-400">
              {checkResult.message ?? t('compliance.checkSummary', { checked: checkResult.checked, compliant: checkResult.compliant, nonCompliant: checkResult.non_compliant })}
            </p>
          </div>
          <button onClick={() => setCheckResult(null)} className="ml-auto text-gray-500 hover:text-gray-300 text-sm">
            {t('compliance.dismiss')}
          </button>
        </div>
      )}

      {/* Create / edit policy form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-xl p-5 mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-200">
            {editingId ? t('compliance.editPolicyTitle') : t('compliance.createPolicyTitle')}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('compliance.nameField')}</label>
              <input
                type="text"
                value={policyName}
                onChange={e => setPolicyName(e.target.value)}
                className={inputCls}
                placeholder="required-tags"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('compliance.severity')}</label>
              <select
                value={severity}
                onChange={e => setSeverity(e.target.value)}
                className={inputCls}
              >
                {SEVERITIES.map(s => <option key={s} value={s}>{t(`status.${s}`, { defaultValue: s.charAt(0).toUpperCase() + s.slice(1) })}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('common.description')}</label>
            <input
              type="text"
              value={policyDesc}
              onChange={e => setPolicyDesc(e.target.value)}
              className={inputCls}
              placeholder={t('compliance.policyDescPlaceholder')}
            />
          </div>

          {/* Target scope (T16) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('compliance.targetScope')}</label>
              <select
                value={targetType}
                onChange={(e) => setTargetType(e.target.value as 'all' | 'ci_type' | 'dynamic_group')}
                className={inputCls}
                data-testid="compliance-target-type"
              >
                <option value="all">{t('compliance.targetAll')}</option>
                <option value="ci_type">{t('compliance.targetTypeOption')}</option>
                <option value="dynamic_group">{t('compliance.targetGroup')}</option>
              </select>
            </div>
            {targetType === 'ci_type' && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('compliance.targetTypeOption')}</label>
                <select value={targetTypeId} onChange={(e) => setTargetTypeId(e.target.value)} className={inputCls}>
                  <option value="">{t('compliance.selectType')}</option>
                  {ciTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.display_name}</option>
                  ))}
                </select>
              </div>
            )}
            {targetType === 'dynamic_group' && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('compliance.targetGroup')}</label>
                <select value={targetGroupId} onChange={(e) => setTargetGroupId(e.target.value)} className={inputCls}>
                  <option value="">{t('compliance.selectGroup')}</option>
                  {dynGroups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Rules editor */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="block text-xs text-gray-400">{t('compliance.rules')} *</label>
              <span className="text-xs text-gray-600">{t('compliance.rulesHint')}</span>
            </div>
            <div className="space-y-2">
              {rules.map((r, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    aria-label={t('compliance.ruleFieldAria', { index: i + 1 })}
                    value={r.field}
                    onChange={e => updateRule(i, { field: e.target.value })}
                    className={`${inputCls} col-span-4`}
                    placeholder={t('compliance.ruleFieldPlaceholder')}
                  />
                  <select
                    aria-label={t('compliance.ruleOpAria', { index: i + 1 })}
                    value={r.op}
                    onChange={e => updateRule(i, { op: e.target.value })}
                    className={`${inputCls} col-span-3`}
                  >
                    {RULE_OPS.map(o => (
                      <option key={o.value} value={o.value}>
                        {t(`compliance.op.${o.value}`, { defaultValue: o.value })}
                      </option>
                    ))}
                  </select>
                  {opNeedsValue(r.op) ? (
                    <input
                      type="text"
                      aria-label={t('compliance.ruleValueAria', { index: i + 1 })}
                      value={r.value}
                      onChange={e => updateRule(i, { value: e.target.value })}
                      className={`${inputCls} col-span-4`}
                      placeholder={r.op === 'in' ? t('compliance.ruleValueInHint') : t('compliance.ruleValue')}
                    />
                  ) : (
                    <div className="col-span-4" />
                  )}
                  <button
                    type="button"
                    onClick={() => setRules(rs => rs.filter((_, idx) => idx !== i))}
                    disabled={rules.length === 1}
                    aria-label={t('compliance.removeRuleAria', { index: i + 1 })}
                    className="col-span-1 text-red-500/60 hover:text-red-400 disabled:opacity-30 text-sm transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRules(rs => [...rs, { ...DEFAULT_RULE }])}
              className="mt-2 text-xs text-indigo-400 hover:text-indigo-300"
            >
              {t('compliance.addRule')}
            </button>
          </div>

          {formError && <p className="text-sm text-red-400">{formError}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeForm} className="px-4 py-2 text-sm text-gray-400 hover:text-white">{t('common.cancel')}</button>
            <button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg"
            >
              {editingId
                ? (updateMutation.isPending ? t('compliance.saving') : t('compliance.save'))
                : (createMutation.isPending ? t('compliance.creating') : t('compliance.createPolicy'))}
            </button>
          </div>
        </form>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-800/50 rounded-lg p-1 w-fit">
        {(['policies', 'results'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded text-sm transition-colors ${
              activeTab === tab ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {tab === 'policies' ? t('compliance.tabPolicies') : t('compliance.tabResults')}
          </button>
        ))}
      </div>

      {/* Policies tab */}
      {activeTab === 'policies' && (
        loadingPolicies ? (
          <div className="text-center py-20 text-gray-500">{t('compliance.loadingPolicies')}</div>
        ) : policies.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">📋</p>
            <p className="text-gray-400 text-lg font-medium">{t('compliance.noPolicies')}</p>
            <p className="text-gray-600 text-sm mt-1">{t('compliance.noPoliciesHint')}</p>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-gray-400 text-xs font-medium uppercase tracking-wider border-b border-gray-700">
                  <th className="px-4 py-3 text-left">{t('compliance.policy')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.rules')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.severity')}</th>
                  <th className="px-4 py-3 text-left">{t('common.status')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {policies.map(p => (
                  <tr key={p.id} className="border-b border-gray-700/50 last:border-0">
                    <td className="px-4 py-3">
                      <p className="text-white font-medium">{p.name}</p>
                      {p.description && <p className="text-gray-500 text-xs mt-0.5">{p.description}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {Array.isArray(p.rules) && p.rules.length > 0 ? (
                        <span className="text-gray-300 text-sm">
                          {t('compliance.rulesCount', { count: p.rules.length })}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-sm">{t('compliance.noRules')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.severity ? (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${SEVERITY_COLORS[p.severity] ?? 'bg-gray-700 text-gray-400'}`}>
                          {t(`status.${p.severity}`, { defaultValue: p.severity })}
                        </span>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm ${p.is_active ? 'text-green-400' : 'text-gray-500'}`}>
                        {p.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => openEdit(p)}
                        className="text-indigo-400/80 hover:text-indigo-300 text-xs mr-3 transition-colors"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        onClick={() => toggleMutation.mutate(p)}
                        className="text-gray-400 hover:text-gray-200 text-xs mr-3 transition-colors"
                      >
                        {p.is_active ? t('compliance.deactivate') : t('compliance.activate')}
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(p.id)}
                        className="text-red-500/60 hover:text-red-400 text-xs transition-colors"
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Results tab */}
      {activeTab === 'results' && (
        loadingResults ? (
          <div className="text-center py-20 text-gray-500">{t('compliance.loadingResults')}</div>
        ) : results.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-gray-400 text-lg font-medium">{t('compliance.noResults')}</p>
            <p className="text-gray-600 text-sm mt-1">{t('compliance.noResultsHint')}</p>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-gray-400 text-xs font-medium uppercase tracking-wider border-b border-gray-700">
                  <th className="px-4 py-3 text-left">{t('compliance.ci')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.policy')}</th>
                  <th className="px-4 py-3 text-left">{t('common.status')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.violations')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.checked')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.id} className="border-b border-gray-700/50 last:border-0 align-top">
                    <td className="px-4 py-3 text-gray-200 font-medium">{r.ci_name}</td>
                    <td className="px-4 py-3 text-gray-400 text-sm">{r.policy_name}</td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${STATUS_COLORS[r.status ?? 'unknown'] ?? 'text-gray-400'}`}>
                        {t(`status.${r.status ?? 'unknown'}`, { defaultValue: r.status ?? 'unknown' })}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.status === 'non_compliant' && Array.isArray(r.details) && r.details.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {r.details.map((v, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 rounded-full bg-red-900/30 border border-red-800/60 text-red-300 text-xs"
                            >
                              {violationText(v)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(r.checked_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
