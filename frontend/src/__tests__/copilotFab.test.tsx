import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useCopilotStore } from '../store/copilotStore'
import CopilotFab from '../components/copilot/CopilotFab'
import i18n from '../i18n'

describe('CopilotFab', () => {
  beforeEach(() => {
    act(() => useCopilotStore.getState().setOpen(false))
  })

  it('toggles the global window and exposes the open state', () => {
    render(<CopilotFab />)
    const fab = screen.getByRole('button', { name: 'Open Copilot' })
    fireEvent.click(fab)
    expect(useCopilotStore.getState().open).toBe(true)
    expect(fab).toHaveAttribute('aria-controls', 'copilot-window')
    fireEvent.click(fab)
    expect(useCopilotStore.getState().open).toBe(false)
  })

  it('keeps the launcher mounted for focus restoration', () => {
    render(<CopilotFab />)
    act(() => useCopilotStore.getState().setOpen(true))
    expect(screen.getByRole('button', { name: 'Minimize Copilot' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('label is localized in Chinese', async () => {
    await i18n.changeLanguage('zh')
    render(<CopilotFab />)
    expect(screen.getByRole('button', { name: '打开助手' })).toBeInTheDocument()
    await i18n.changeLanguage('en')
  })
})
