import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AiProviderSection from '../components/settings/AiProviderSection'
import { useOrgStore } from '../store/orgStore'
import i18n from '../i18n'
import type { Organization } from '../types'

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
  },
}))

import api from '../lib/api'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

const localInfo = {
  data: {
    source: 'local',
    api_key_set: false,
    api_key_hint: null,
    env_present: false,
    stored: { ai_provider_enabled: false, ai_base_url: null, ai_chat_model: null, ai_embed_model: null },
    effective: { base_url: 'https://api.openai.com/v1', chat_model: 'gpt-4o-mini', embed_model: 'text-embedding-3-small' },
  },
}

const orgInfo = {
  data: {
    source: 'org',
    api_key_set: true,
    api_key_hint: '…1234',
    env_present: false,
    stored: { ai_provider_enabled: true, ai_base_url: 'https://relay.example.com/v1', ai_chat_model: 'glm-4o', ai_embed_model: null },
    effective: { base_url: 'https://relay.example.com/v1', chat_model: 'glm-4o', embed_model: 'text-embedding-3-small' },
  },
}

function renderSection() {
  return render(
    <MemoryRouter>
      <AiProviderSection />
    </MemoryRouter>
  )
}

describe('AiProviderSection', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.clearAllMocks()
  })

  it('shows local-mode badge and hint when nothing configured', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: localInfo })
    renderSection()
    expect(await screen.findByText('Local mode')).toBeInTheDocument()
    expect(screen.getByText(/No API key configured/i)).toBeInTheDocument()
  })

  it('shows org badge, masked key and keep-unchanged placeholder', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: orgInfo })
    renderSection()
    expect(await screen.findByText('Org config')).toBeInTheDocument()
    expect(screen.getByText('Set (…1234)')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Leave blank to keep unchanged')).toBeInTheDocument()
  })

  it('clear-key flow sends __CLEAR__ on save', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: orgInfo })
    vi.mocked(api.put).mockResolvedValue({ data: orgInfo })
    renderSection()
    await screen.findByText('Set (…1234)')
    fireEvent.click(screen.getByText('Clear key'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/orgs/org-001/ai/provider',
        expect.objectContaining({ api_key: '__CLEAR__' })
      )
    })
  })

  it('save with a new key sends it and shows saved message', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: localInfo })
    vi.mocked(api.put).mockResolvedValue({ data: localInfo })
    renderSection()
    await screen.findByText('Local mode')
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-new-9999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/orgs/org-001/ai/provider',
        expect.objectContaining({ api_key: 'sk-new-9999' })
      )
    })
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  it('test button shows failure banner with error', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: localInfo })
    vi.mocked(api.post).mockResolvedValue({ data: { data: { ok: false, error: 'upstream returned 401' } } })
    renderSection()
    await screen.findByText('Local mode')
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText(/Connection failed: upstream returned 401/i)).toBeInTheDocument()
  })

  it('test button shows success banner', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: localInfo })
    vi.mocked(api.post).mockResolvedValue({ data: { data: { ok: true, error: null } } })
    renderSection()
    await screen.findByText('Local mode')
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Connection successful.')).toBeInTheDocument()
  })

  it('zh localization renders badge and hint in Chinese', async () => {
    await i18n.changeLanguage('zh')
    vi.mocked(api.get).mockResolvedValue({ data: localInfo })
    renderSection()
    expect(await screen.findByText('本地模式')).toBeInTheDocument()
    expect(screen.getByText(/未配置 API Key/i)).toBeInTheDocument()
    await i18n.changeLanguage('en')
  })
})
