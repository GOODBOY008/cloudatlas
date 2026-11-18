import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router-dom'
import { useOrgStore } from '../store/orgStore'
import { useCopilotStore } from '../store/copilotStore'
import { DEFAULT_LAYOUT } from '../lib/copilotWindow'
import CopilotPanel from '../components/CopilotPanel'
import type { Organization } from '../types'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }
vi.mock('../lib/api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: { data: [] } }) } }))

function openPanel() {
  act(() => {
    useCopilotStore.getState().setOpen(true)
  })
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <CopilotPanel />
    </MemoryRouter>
  )
}

describe('CopilotPanel', () => {
  beforeEach(() => {
    act(() => {
      useCopilotStore.getState().setOpen(false)
      useCopilotStore.getState().setLayout(DEFAULT_LAYOUT)
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.stubGlobal('matchMedia', undefined) // desktop fallback
  })
  afterEach(() => vi.unstubAllGlobals())

  it('renders nothing when closed', () => {
    const { container } = renderPanel()
    expect(container.firstChild).toBeNull()
  })

  it('opens a non-modal native dialog on desktop', () => {
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show')
    renderPanel()
    openPanel()
    expect(show).toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Copilot' })).toHaveAttribute('open')
    show.mockRestore()
  })

  it('renders a modal dialog bottom sheet on mobile', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false, // mobile
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
    )
    renderPanel()
    openPanel()
    const dialog = screen.getByRole('dialog', { name: 'Copilot' })
    expect(dialog.tagName).toBe('DIALOG')
    expect(dialog).toHaveAttribute('open')
    expect(dialog).toHaveAccessibleName('Copilot')
  })

  it('Cmd/Ctrl+I toggles the panel', () => {
    renderPanel()
    fireEvent.keyDown(window, { metaKey: true, key: 'i' })
    expect(useCopilotStore.getState().open).toBe(true)
    fireEvent.keyDown(window, { metaKey: true, key: 'i' })
    expect(useCopilotStore.getState().open).toBe(false)
  })

  it('Escape closes an open panel', () => {
    renderPanel()
    openPanel()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useCopilotStore.getState().open).toBe(false)
  })

  it('shares geometry between keyboard, click controls and reset', () => {
    renderPanel()
    openPanel()
    const handle = screen.getByRole('button', { name: /Resize window/ })
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(useCopilotStore.getState().layout.width).toBe(560)
    for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useCopilotStore.getState().layout.width).toBe(320)
    fireEvent.click(handle)
    fireEvent.click(screen.getByRole('button', { name: 'Increase width' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease height' }))
    expect(useCopilotStore.getState().layout).toMatchObject({ width: 336, height: 544 })
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
    expect(useCopilotStore.getState().layout).toEqual(DEFAULT_LAYOUT)
  })

  it('defers Escape and the global shortcut to an open business dialog', () => {
    render(<MemoryRouter><CopilotPanel /><div role="dialog" aria-modal="true" aria-label="Search" /></MemoryRouter>)
    openPanel()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(useCopilotStore.getState().open).toBe(true)
  })

  it('receives a reply while minimized and restores the draft with the new page context', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve({
      ok: true, body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }),
    }))
    vi.stubGlobal('fetch', fetch)
    render(<MemoryRouter initialEntries={['/dashboard']}><Link to="/recommendations">Next page</Link><CopilotPanel /></MemoryRouter>)
    openPanel()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Check costs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => stream.enqueue(new TextEncoder().encode('data: {"delta":"Background"}\n\n')))
    expect(screen.getByText('Background')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My next question' } })
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Copilot' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Next page' }))
    await act(async () => {
      stream.enqueue(new TextEncoder().encode('data: {"delta":" reply"}\n\ndata: {"done":true}\n\n'))
      stream.close()
    })
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false)
    openPanel()
    expect(screen.getByText('Background reply')).toBeVisible()
    expect(screen.getByRole('textbox')).toHaveValue('My next question')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(JSON.parse(String(fetch.mock.calls[1][1].body)).page_context).toBe('/recommendations')
    await act(async () => stream.close())
  })
})
