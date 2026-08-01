import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import renderMarkdown from '../components/copilot/renderMarkdown'

describe('renderMarkdown', () => {
  it('renders bold and inline code in paragraphs', () => {
    render(<div>{renderMarkdown('plain **bold** and `code` end')}</div>)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getByText(/plain/)).toBeInTheDocument()
  })

  it('renders bullet and numbered lists', () => {
    render(<div>{renderMarkdown('- one\n- two\n1. first\n2. second')}</div>)
    expect(screen.getAllByRole('list').length).toBe(2)
    expect(screen.getByText('two')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('renders fenced code blocks', () => {
    render(<div>{renderMarkdown('before\n```\nSELECT 1\n```\nafter')}</div>)
    expect(screen.getByText('SELECT 1').tagName).toBe('PRE')
    expect(screen.getByText(/after/)).toBeInTheDocument()
  })
})
