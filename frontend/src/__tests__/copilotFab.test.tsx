import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useCopilotStore } from '../store/copilotStore'
import CopilotFab from '../components/copilot/CopilotFab'
import i18n from '../i18n'

describe('CopilotFab', () => {
  beforeEach(() => {
    act(() => useCopilotStore.getState().setOpen(false))
  })

  it('opens the copilot and is mobile-only', () => {
    render(<CopilotFab />)
    const fab = screen.getByRole('button', { name: 'Open Copilot' })
    expect(fab.className).toContain('lg:hidden')
    expect(fab.className).toContain('bottom-5')
    expect(fab.className).toContain('right-5')
    fireEvent.click(fab)
    expect(useCopilotStore.getState().open).toBe(true)
  })

  it('hides when the panel is open', () => {
    render(<CopilotFab />)
    act(() => useCopilotStore.getState().setOpen(true))
    expect(screen.queryByRole('button', { name: 'Open Copilot' })).not.toBeInTheDocument()
  })

  it('label is localized in Chinese', async () => {
    await i18n.changeLanguage('zh')
    render(<CopilotFab />)
    expect(screen.getByRole('button', { name: '打开助手' })).toBeInTheDocument()
    await i18n.changeLanguage('en')
  })
})
