import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useOrgStore } from '../store/orgStore'
import { useCopilotStore, MIN_WIDTH, MAX_WIDTH } from '../store/copilotStore'
import CopilotPanel from '../components/CopilotPanel'
import type { Organization } from '../types'

const org: Organization = { id: 'org-001', name: 'Acme Corp', slug: 'acme' }

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
      useCopilotStore.getState().setWidth(400)
      useOrgStore.getState().clearOrg()
      useOrgStore.getState().setCurrentOrg(org)
    })
    vi.stubGlobal('matchMedia', undefined) // desktop fallback
  })

  it('renders nothing when closed', () => {
    const { container } = renderPanel()
    expect(container.firstChild).toBeNull()
  })

  it('renders a non-modal complementary aside on desktop', () => {
    renderPanel()
    openPanel()
    const aside = screen.getByRole('complementary')
    expect(aside).toHaveAttribute('aria-label', 'Copilot')
    // No backdrop in docked mode.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
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

  it('keyboard-resizes the panel within [MIN_WIDTH, MAX_WIDTH]', () => {
    renderPanel()
    openPanel()
    const handle = screen.getByRole('separator')
    // Widen past the max — ArrowLeft grows the panel.
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(useCopilotStore.getState().width).toBe(MAX_WIDTH)
    for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useCopilotStore.getState().width).toBe(MIN_WIDTH)
  })
})
