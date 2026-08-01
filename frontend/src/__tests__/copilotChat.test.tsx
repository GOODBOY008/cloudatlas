import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrgStore } from '../store/orgStore'
import CopilotChat from '../components/copilot/CopilotChat'
import i18n from '../i18n'
import type { Organization } from '../types'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

function mockFetchStream(delta: string) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`))
      controller.enqueue(encoder.encode('data: {"done":true}\n\n'))
      controller.close()
    },
  })
  return vi.fn().mockResolvedValue({ ok: true, body: stream })
}

/** Stream that enqueues one delta then stays open until the fetch signal aborts. */
function mockFetchStreamUntilAbort(delta: string) {
  const encoder = new TextEncoder()
  return vi.fn().mockImplementation((_url: string, opts: RequestInit) =>
    Promise.resolve({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`))
          opts.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError'))
          )
        },
      }),
    })
  )
}

function renderChat(route = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <CopilotChat />
    </MemoryRouter>
  )
}

describe('CopilotChat', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.restoreAllMocks()
  })

  it('shows greeting and default chips on an unmatched route', () => {
    renderChat('/settings')
    expect(screen.getByText(/CloudAtlas Copilot/i)).toBeInTheDocument()
    expect(screen.getByText(/How much did we spend this month/i)).toBeInTheDocument()
  })

  it('shows page-aware chips and a context pill on /recommendations', () => {
    renderChat('/recommendations')
    expect(screen.getByText(/Which recommendation saves the most/i)).toBeInTheDocument()
    expect(screen.getByText('Recommendations')).toBeInTheDocument() // context pill label
  })

  it('detaching context hides the pill', () => {
    renderChat('/recommendations')
    fireEvent.click(screen.getByLabelText('Detach page context'))
    expect(screen.queryByText('Recommendations')).not.toBeInTheDocument()
  })

  it('streams the assistant reply and renders markdown lists', async () => {
    const fetchMock = mockFetchStream('- item one\n**done**')
    vi.stubGlobal('fetch', fetchMock)
    renderChat('/settings')
    await act(async () => {
      screen.getByText(/How much did we spend this month/i).click()
    })
    expect(await screen.findByText('item one')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orgs/org-001/ai/copilot/chat',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('sends page_context when attached and omits it when detached', async () => {
    const fetchMock = mockFetchStream('ok')
    vi.stubGlobal('fetch', fetchMock)
    renderChat('/recommendations')
    await act(async () => {
      screen.getByText(/Which recommendation saves the most/i).click()
    })
    let body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.page_context).toBe('/recommendations')

    fireEvent.click(screen.getByLabelText('Detach page context'))
    fetchMock.mockClear()
    const input = screen.getByPlaceholderText(/Ask about/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'another question' } })
    await act(async () => {
      fireEvent.submit(input.closest('form')!)
    })
    body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.page_context).toBeUndefined()
  })

  it('stop button aborts streaming and keeps the partial reply', async () => {
    const fetchMock = mockFetchStreamUntilAbort('partial answer ')
    vi.stubGlobal('fetch', fetchMock)
    renderChat('/settings')
    await act(async () => {
      screen.getByText(/How much did we spend this month/i).click()
    })
    expect(await screen.findByText(/partial answer/i)).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Stop' }).click()
    })
    expect(await screen.findByText(/partial answer/i)).toBeInTheDocument()
    expect(screen.getByText(/Stopped/)).toBeInTheDocument()
  })

  it('copy button writes the reply to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.stubGlobal('fetch', mockFetchStream('copy me'))
    renderChat('/settings')
    await act(async () => {
      screen.getByText(/How much did we spend this month/i).click()
    })
    await screen.findByText('copy me')
    await act(async () => {
      screen.getByLabelText('Copy').click()
    })
    expect(writeText).toHaveBeenCalledWith('copy me')
  })

  it('falls back to the error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    renderChat('/settings')
    await act(async () => {
      screen.getByText(/How much did we spend this month/i).click()
    })
    expect(await screen.findAllByText(/unavailable right now/i)).not.toHaveLength(0)
  })

  it('greeting is localized in Chinese', async () => {
    await i18n.changeLanguage('zh')
    renderChat('/settings')
    expect(screen.getByText(/CloudAtlas 助手/i)).toBeInTheDocument()
    expect(screen.getByText(/我们这个月花了多少钱/i)).toBeInTheDocument()
    await i18n.changeLanguage('en')
  })
})
