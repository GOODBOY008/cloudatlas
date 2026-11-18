import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrgStore } from '../store/orgStore'
import CopilotChat from '../components/copilot/CopilotChat'
import i18n from '../i18n'
import type { Organization } from '../types'
import api from '../lib/api'

// Conversation history is independent from the SSE transport. Keep this unit
// suite isolated from any backend that happens to be listening on localhost.
vi.mock('../lib/api', () => ({ default: { get: vi.fn(), delete: vi.fn() } }))

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
    vi.mocked(api.get).mockReset().mockResolvedValue({ data: { data: [] } })
    vi.mocked(api.delete).mockReset().mockResolvedValue({ data: { data: {} } })
  })
  afterEach(() => vi.unstubAllGlobals())

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

  it('aborts the old workspace stream and ignores late chunks after switching workspace', async () => {
    const encoder = new TextEncoder()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(encoder.encode('data: {"delta":"old workspace reply"}\n\n'))
      },
    }) })
    vi.stubGlobal('fetch', fetchMock)
    renderChat('/settings')
    await act(async () => { screen.getByText(/How much did we spend this month/i).click() })
    expect(await screen.findByText('old workspace reply')).toBeInTheDocument()
    await act(async () => {
      useOrgStore.getState().setCurrentOrg({ id: 'org-002', name: 'Next workspace', slug: 'next' })
    })
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
    await act(async () => {
      streamController.enqueue(encoder.encode('data: {"delta":"private old workspace data"}\n\n'))
      streamController.close()
    })
    expect(screen.queryByText(/old workspace/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByText(/How much did we spend this month/i)).toBeInTheDocument()
  })

  it('starting a new chat cancels streaming without putting the old reply back', async () => {
    const fetchMock = mockFetchStreamUntilAbort('previous answer')
    vi.stubGlobal('fetch', fetchMock)
    renderChat('/settings')
    await act(async () => { screen.getByText(/How much did we spend this month/i).click() })
    await screen.findByText('previous answer')
    await act(async () => { screen.getByTitle('New chat').click() })
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
    expect(screen.queryByText('previous answer')).not.toBeInTheDocument()
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument()
    expect(screen.getByText(/How much did we spend this month/i)).toBeInTheDocument()
  })

  it('aborts streaming when the chat panel unmounts', async () => {
    const fetchMock = mockFetchStreamUntilAbort('partial reply')
    vi.stubGlobal('fetch', fetchMock)
    const view = renderChat('/settings')
    await act(async () => { screen.getByText(/How much did we spend this month/i).click() })
    await screen.findByText('partial reply')
    await act(async () => { view.unmount() })
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('ignores history loaded for a previous workspace', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(api.get).mockReturnValueOnce(new Promise(res => { resolve = res }))
    renderChat('/settings')
    await act(async () => {
      useOrgStore.getState().setCurrentOrg({ id: 'org-002', name: 'Next workspace', slug: 'next' })
    })
    await act(async () => resolve({ data: { data: [{ id: 'old', title: 'Private old chat', message_count: 1, updated_at: '' }] } }))
    fireEvent.click(screen.getByTitle('History'))
    expect(screen.queryByText('Private old chat')).not.toBeInTheDocument()
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
