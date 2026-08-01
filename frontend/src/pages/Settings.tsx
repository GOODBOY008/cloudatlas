import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import AiProviderSection from '../components/settings/AiProviderSection'
import { useOrgStore } from '../store'

interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  last_used_at: string | null
  created_at: string
}

interface Member {
  user_id: string
  email: string
  display_name: string
  roles: string[]
  joined_at: string
}

interface InviteForm {
  email: string
  role: string
}

interface OrgDetails {
  id: string
  name: string
  slug: string
  description?: string | null
  settings?: Record<string, unknown>
}

export default function Settings() {
  const { t } = useTranslation()
  const { currentOrg, setCurrentOrg } = useOrgStore()
  const [activeTab, setActiveTab] = useState<'org' | 'keys' | 'security' | 'aiProvider'>('org')
  const queryClient = useQueryClient()
  const [orgForm, setOrgForm] = useState({ name: '', description: '', currency: 'USD' })
  const [orgSaveMsg, setOrgSaveMsg] = useState<string | null>(null)
  const [inviteForm, setInviteForm] = useState<InviteForm>({ email: '', role: 'viewer' })
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState(false)

  const orgId = currentOrg?.id

  const { data: members, isLoading } = useQuery<Member[]>({
    queryKey: ['org-members', orgId],
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Member[] }>(`/organizations/${orgId}/members`)
      return res.data ?? []
    },
    enabled: !!orgId,
  })

  const { data: orgDetails } = useQuery<OrgDetails>({
    queryKey: ['org-details', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: OrgDetails }>(`/organizations/${orgId}`)
      return res.data
    },
  })

  useEffect(() => {
    if (!orgDetails) return
    setOrgForm({
      name: orgDetails.name ?? '',
      description: orgDetails.description ?? '',
      currency: (orgDetails.settings as { currency?: string } | undefined)?.currency ?? 'USD',
    })
  }, [orgDetails])

  const updateOrgMutation = useMutation({
    mutationFn: () =>
      api.put<{ data: OrgDetails }>(`/organizations/${orgId}`, {
        name: orgForm.name.trim(),
        description: orgForm.description.trim() || null,
        currency: orgForm.currency,
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['org-details', orgId] })
      setOrgSaveMsg(t('settings.saved'))
      if (currentOrg && res.data?.data?.name) {
        setCurrentOrg({ ...currentOrg, name: res.data.data.name, slug: res.data.data.slug ?? currentOrg.slug })
      }
      setTimeout(() => setOrgSaveMsg(null), 2500)
    },
    onError: () => setOrgSaveMsg(t('settings.updateFailed')),
  })

  const inviteMutation = useMutation({
    mutationFn: (payload: InviteForm) =>
      api.post(`/organizations/${orgId}/members`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] })
      setInviteForm({ email: '', role: 'viewer' })
      setInviteSuccess(true)
      setInviteError(null)
      setTimeout(() => setInviteSuccess(false), 3000)
    },
    onError: (err: any) => {
      setInviteError(err?.response?.data?.message ?? t('settings.inviteFailed'))
    },
  })

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/organizations/${orgId}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] })
    },
  })

  const roleMutation = useMutation({
    mutationFn: ({ userId, roleName }: { userId: string; roleName: string }) =>
      api.put(`/orgs/${orgId}/members/${userId}/role`, { role_name: roleName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] })
    },
  })

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteForm.email) return
    inviteMutation.mutate(inviteForm)
  }

  if (!orgId) {
    return (
      <div className="p-8 text-center text-gray-500">
        {t('settings.noOrgSelected')}
      </div>
    )
  }

  const orgSection = (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold text-white">{t('settings.title')}</h2>
      </div>

      {/* Organization Info */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h3 className="text-base font-semibold text-gray-100 mb-4">{t('settings.organization')}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            updateOrgMutation.mutate()
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500 block mb-1">{t('settings.currency')}</span>
                <select
                  value={orgForm.currency ?? 'USD'}
                  onChange={(e) => setOrgForm({ ...orgForm, currency: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'AUD', 'CAD'].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            <div>
              <span className="text-gray-500 block mb-1">{t('settings.name')}</span>
              <input
                value={orgForm.name}
                onChange={(e) => setOrgForm((s) => ({ ...s, name: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <span className="text-gray-500 block mb-1">{t('settings.slug')}</span>
              <span className="font-medium font-mono text-gray-300">{currentOrg?.slug}</span>
            </div>
          </div>
          <div>
            <span className="text-gray-500 block mb-1">{t('settings.description')}</span>
            <textarea
              value={orgForm.description}
              onChange={(e) => setOrgForm((s) => ({ ...s, description: e.target.value }))}
              rows={2}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <span className="text-gray-500 block mb-1">{t('settings.id')}</span>
            <span className="font-medium font-mono text-xs text-gray-500">{currentOrg?.id}</span>
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            {orgSaveMsg && <span className="text-xs text-gray-400">{orgSaveMsg}</span>}
            <button
              type="submit"
              disabled={updateOrgMutation.isPending || !orgForm.name.trim()}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {updateOrgMutation.isPending ? t('common.loading') : t('settings.save')}
            </button>
          </div>
        </form>
      </div>

      {/* Exchange rates */}
      <FxRatesSection />

      {/* Members */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h3 className="text-base font-semibold text-gray-100 mb-4">{t('settings.members')}</h3>

        {/* Invite Form */}
        <form onSubmit={handleInvite} className="flex gap-3 mb-5">
          <input
            type="email"
            placeholder={t('settings.emailPlaceholder')}
            value={inviteForm.email}
            onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
            className="flex-1 border border-gray-700 bg-gray-800 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            required
          />
          <select
            value={inviteForm.role}
            onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
            className="border border-gray-700 bg-gray-800 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="viewer">{t('settings.role.viewer')}</option>
            <option value="finops">{t('settings.role.finops')}</option>
            <option value="cmdb_editor">{t('settings.role.cmdbEditor')}</option>
            <option value="admin">{t('settings.role.admin')}</option>
          </select>
          <button
            type="submit"
            disabled={inviteMutation.isPending}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {inviteMutation.isPending ? t('settings.inviting') : t('settings.invite')}
          </button>
        </form>

        {inviteError && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
            {inviteError}
          </div>
        )}
        {inviteSuccess && (
          <div className="mb-4 p-3 rounded-lg bg-green-900/40 border border-green-700 text-green-400 text-sm">
            {t('settings.inviteSuccess')}
          </div>
        )}

        {/* Member list */}
        {isLoading ? (
          <p className="text-gray-500 text-sm">{t('settings.loadingMembers')}</p>
        ) : (
          <div className="divide-y divide-gray-800">
            {(members ?? []).map((m) => (
              <div key={m.user_id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-gray-100">{m.display_name || m.email}</p>
                  <p className="text-xs text-gray-500">{m.email}</p>
                </div>
                <div className="flex items-center gap-4">
                  <select
                    value={(m.roles?.[0] ?? t('settings.role.member')).toLowerCase()}
                    onChange={(e) => roleMutation.mutate({ userId: m.user_id, roleName: e.target.value })}
                    className="text-xs border border-gray-700 rounded-lg px-2 py-1 bg-gray-800 text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="owner">{t('settings.role.owner')}</option>
                    <option value="admin">{t('settings.role.admin')}</option>
                    <option value="member">{t('settings.role.member')}</option>
                    <option value="viewer">{t('settings.role.viewer')}</option>
                  </select>
                  <button
                    onClick={() => removeMutation.mutate(m.user_id)}
                    disabled={removeMutation.isPending}
                    className="text-xs text-red-400 hover:text-red-300 hover:underline disabled:opacity-50 transition-colors"
                  >
                    {t('settings.removeMember')}
                  </button>
                </div>
              </div>
            ))}
            {(members ?? []).length === 0 && (
              <p className="text-sm text-gray-500 py-3">{t('settings.noMembers')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div>
      <div className="flex gap-1 border-b border-gray-800 mb-6">
        {([
          ['org', t('settings.organization')],
          ['keys', t('settings.apiKeys')],
          ['security', t('settings.security')],
          ['aiProvider', t('settings.aiProvider')],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === key
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab === 'org' && orgSection}
      {activeTab === 'keys' && <ApiKeysSection />}
      {activeTab === 'security' && <SecuritySection />}
      {activeTab === 'aiProvider' && <AiProviderSection />}
    </div>
  )
}

// ─── FX Rates (currency normalization) ────────────────────────────────────────

interface FxRate {
  from_currency: string
  to_currency: string
  rate: number
  updated_at: string
}

function FxRatesSection() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [rates, setRates] = useState<FxRate[]>([])
  const [orgCurrency, setOrgCurrency] = useState('USD')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!orgId) return
    api
      .get<{ data: FxRate[]; org_currency: string }>(`/orgs/${orgId}/exchange-rates`)
      .then((res) => {
        setRates(res.data.data ?? [])
        setOrgCurrency(res.data.org_currency ?? 'USD')
        setLoaded(true)
      })
      .catch(() => setError(t('settings.fxLoadFailed')))
  }, [orgId, t])

  function updateRate(idx: number, value: string) {
    const v = parseFloat(value)
    setRates((prev) => prev.map((r, i) => (i === idx ? { ...r, rate: isNaN(v) ? 0 : v } : r)))
  }

  async function save() {
    if (!orgId) return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      await api.put(`/orgs/${orgId}/exchange-rates`, { rates })
      setMessage(t('settings.fxSaved'))
    } catch {
      setError(t('settings.fxSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
      <h3 className="text-base font-semibold text-gray-100 mb-1">{t('settings.fxRates')}</h3>
      <p className="text-xs text-gray-500 mb-1">{t('settings.fxOrgCurrency', { currency: orgCurrency })}</p>
      <p className="text-xs text-gray-500 mb-4">{t('settings.fxHint')}</p>
      {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
      {message && <p className="text-xs text-green-400 mb-3">{message}</p>}
      {loaded && rates.length === 0 ? (
        <p className="text-sm text-gray-500">{t('settings.fxNoRates')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">{t('settings.fxFrom')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.fxTo')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.fxRate')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.fxUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r, idx) => (
                <tr key={`${r.from_currency}-${r.to_currency}`} className="border-b border-gray-800 last:border-0">
                  <td className="px-3 py-2 text-sm font-mono text-gray-200">{r.from_currency}</td>
                  <td className="px-3 py-2 text-sm font-mono text-gray-200">{r.to_currency}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      value={r.rate}
                      onChange={(e) => updateRate(idx, e.target.value)}
                      className={`${inputCls} w-32 font-mono`}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rates.length > 0 && (
        <div className="flex justify-end mt-4">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? t('common.loading') : t('settings.fxSave')}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── API Keys (I1) ────────────────────────────────────────────────────────────

function ApiKeysSection() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [name, setName] = useState('')
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null)
  const [error, setError] = useState('')

  function loadKeys() {
    if (!orgId) return
    api
      .get<{ data: ApiKeyRow[] }>(`/orgs/${orgId}/api-keys`)
      .then((res) => setKeys(res.data.data ?? []))
      .catch(() => {})
  }
  useEffect(() => {
    loadKeys()
  }, [orgId])

  async function createKey() {
    if (!orgId || !name.trim()) return
    try {
      const { data: res } = await api.post<{ data: { key: string; name: string } }>(
        `/orgs/${orgId}/api-keys`,
        { name: name.trim() }
      )
      setRevealed(res.data)
      setName('')
      setError('')
      loadKeys()
    } catch {
      setError(t('settings.saveFailed'))
    }
  }

  async function revokeKey(id: string) {
    if (!orgId) return
    await api.delete(`/orgs/${orgId}/api-keys/${id}`)
    loadKeys()
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
      <h3 className="text-base font-semibold text-gray-100 mb-4">{t('settings.apiKeys')}</h3>
      <div className="flex gap-2 mb-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.keyName')}
          className={`${inputCls} flex-1`}
        />
        <button
          onClick={createKey}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {t('settings.createKey')}
        </button>
      </div>
      {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
      {revealed && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-200 text-sm">
          <p className="font-medium mb-1">{t('settings.keyCreated')}</p>
          <code className="text-xs break-all">{revealed.key}</code>
        </div>
      )}
      {keys.length === 0 ? (
        <p className="text-sm text-gray-500">{t('settings.noKeys')}</p>
      ) : (
        <table className="w-full text-left">
          <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">{t('settings.name')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.keyPrefix')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.keyLastUsed')}</th>
              <th className="px-3 py-2 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-gray-800 last:border-0">
                <td className="px-3 py-2 text-sm text-white">{k.name}</td>
                <td className="px-3 py-2 text-xs font-mono text-gray-400">{k.key_prefix}…</td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : t('common.never')}
                </td>
                <td className="px-3 py-2">
                  <button onClick={() => revokeKey(k.id)} className="text-xs text-red-400 hover:text-red-300">
                    {t('settings.revokeKey')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─── Security / 2FA (I5) ──────────────────────────────────────────────────────

function SecuritySection() {
  const { t } = useTranslation()
  const [secret, setSecret] = useState('')
  const [otpauth, setOtpauth] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function enroll() {
    setError('')
    try {
      const { data: res } = await api.post<{ data: { secret: string; otpauth_url: string } }>(
        '/auth/2fa/enroll',
        { password }
      )
      setSecret(res.data.secret)
      setOtpauth(res.data.otpauth_url)
    } catch {
      setError(t('settings.badPassword'))
    }
  }

  async function verify() {
    setError('')
    try {
      await api.post('/auth/2fa/verify', { password: secret, code })
      setMessage(t('settings.twoFactorEnabled'))
      setSecret('')
      setOtpauth('')
      setCode('')
    } catch {
      setError(t('settings.badCode'))
    }
  }

  async function disable() {
    setError('')
    try {
      await api.post('/auth/2fa/disable', { password })
      setMessage(t('settings.twoFactorDisabled'))
    } catch {
      setError(t('settings.badPassword'))
    }
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 max-w-lg">
      <h3 className="text-base font-semibold text-gray-100 mb-4">{t('settings.twoFactor')}</h3>
      {message && <p className="text-xs text-green-400 mb-3">{message}</p>}
      {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
      {!secret && !otpauth && (
        <div className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('settings.currentPassword')}
            className={`${inputCls} w-full`}
          />
          <button
            onClick={enroll}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {t('settings.enable2fa')}
          </button>
        </div>
      )}
      {otpauth && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">{t('settings.scanQr')}</p>
          <code className="block text-xs text-gray-300 break-all bg-gray-800 rounded-lg p-2">{otpauth}</code>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            placeholder={t('login.totpCode')}
            className={`${inputCls} w-full`}
          />
          <button
            onClick={verify}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {t('settings.verifyAndEnable')}
          </button>
        </div>
      )}
      {!otpauth && (
        <button onClick={disable} className="mt-4 text-xs text-red-400 hover:text-red-300">
          {t('settings.disable2fa')}
        </button>
      )}
    </div>
  )
}

