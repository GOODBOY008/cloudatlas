import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface TaggingPolicy {
  id: string
  name: string
  description: string | null
  required_tags: Array<string | { key: string; allowed_values?: string[] }>
  apply_to: unknown
  is_active: boolean
  created_at: string
}

interface PolicyForm {
  name: string
  description: string
  required_tags: string
  apply_to: string
}

const DEFAULT_FORM: PolicyForm = { name: '', description: '', required_tags: '', apply_to: '' }

export default function TaggingPolicies() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PolicyForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { data: policies = [], isLoading, isError } = useQuery<TaggingPolicy[]>({
    queryKey: ['tagging-policies', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: TaggingPolicy[] }>(`/orgs/${orgId}/tagging-policies`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: unknown) => api.post(`/orgs/${orgId}/tagging-policies`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tagging-policies', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('taggingPolicies.saveFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: unknown }) =>
      api.put(`/orgs/${orgId}/tagging-policies/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tagging-policies', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('taggingPolicies.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/tagging-policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tagging-policies', orgId] }),
  })

  function openCreate() {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setShowModal(true)
  }

  function openEdit(p: TaggingPolicy) {
    setEditingId(p.id)
    setForm({
      name: p.name,
      description: p.description ?? '',
      required_tags: p.required_tags.map((x) => (typeof x === 'string' ? x : (x as { key: string }).key)).join(', '),
      apply_to: Array.isArray(p.apply_to) ? p.apply_to.join(', ') : '',
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
      setFormError(t('taggingPolicies.nameRequired'))
      return
    }
    const tags = form.required_tags.split(',').map((t) => t.trim()).filter(Boolean)
    if (tags.length === 0) {
      setFormError(t('taggingPolicies.tagRequired'))
      return
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      required_tags: tags,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(form.apply_to.trim()
        ? { apply_to: form.apply_to.split(',').map((t) => t.trim()).filter(Boolean) }
        : {}),
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
        <h2 className="text-xl font-semibold text-white">{t('taggingPolicies.title')}</h2>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('taggingPolicies.newPolicy')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('taggingPolicies.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : policies.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('taggingPolicies.empty')}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                <th className="px-4 py-3 font-medium">{t('taggingPolicies.colRequiredTags')}</th>
                <th className="px-4 py-3 font-medium">{t('taggingPolicies.colAppliesTo')}</th>
                <th className="px-4 py-3 font-medium">{t('common.active')}</th>
                <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-sm text-white">{p.name}</span>
                    {p.description && (
                      <span className="block text-xs text-gray-500">{p.description}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {p.required_tags.map((tag) => {
                        const label = typeof tag === 'string' ? tag : (tag as { key: string }).key
                        return (
                          <span key={label} className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-900/40 text-indigo-300">
                            {label}
                          </span>
                        )
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {Array.isArray(p.apply_to) && p.apply_to.length > 0
                      ? p.apply_to.join(', ')
                      : t('taggingPolicies.allResources')}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">{p.is_active ? '✓' : '✗'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 text-xs">
                      <button onClick={() => openEdit(p)} className="text-indigo-400 hover:text-indigo-300">
                        {t('common.edit')}
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(t('taggingPolicies.deleteConfirm', { name: p.name }))) {
                            deleteMutation.mutate(p.id)
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
              {editingId ? t('taggingPolicies.editTitle') : t('taggingPolicies.newTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                  placeholder="prod-required-tags"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.description')}</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className={inputCls}
                  placeholder={t('taggingPolicies.optional')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  {t('taggingPolicies.requiredTagsLabel')}
                </label>
                <input
                  value={form.required_tags}
                  onChange={(e) => setForm({ ...form, required_tags: e.target.value })}
                  className={inputCls}
                  placeholder="owner, env, cost-center"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  {t('taggingPolicies.applyToLabel')}
                </label>
                <input
                  value={form.apply_to}
                  onChange={(e) => setForm({ ...form, apply_to: e.target.value })}
                  className={inputCls}
                  placeholder="instance, volume, bucket"
                />
              </div>
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
                  {editingId ? t('taggingPolicies.saveChanges') : t('taggingPolicies.createPolicy')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
