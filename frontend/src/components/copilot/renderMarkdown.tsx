import type { ReactNode } from 'react'

/** Inline **bold** and `code` parsing within a line. */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const parts = line.split(/(\*\*.+?\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          className="px-1 py-0.5 rounded bg-gray-200/70 dark:bg-gray-700 text-[0.85em] font-mono"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={key}>{part}</span>
  })
}

/**
 * Markdown-lite renderer for copilot replies — no dependencies (spec §4.3).
 * Supports: **bold**, `inline code`, ``` fenced blocks, "- " bullets,
 * "1. " numbered lists, blank-line-separated paragraphs.
 */
export default function renderMarkdown(text: string): ReactNode {
  const nodes: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim().startsWith('```')) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i])
        i += 1
      }
      i += 1 // skip closing fence
      nodes.push(
        <pre
          key={key++}
          className="my-1 overflow-x-auto rounded-lg bg-gray-100 dark:bg-gray-950 border border-gray-200 dark:border-gray-700 p-3 text-xs font-mono whitespace-pre"
        >
          {code.join('\n')}
        </pre>
      )
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i += 1
      }
      nodes.push(
        <ul key={key++} className="my-1 list-disc pl-5 space-y-0.5">
          {items.map((item, j) => <li key={j}>{renderInline(item, `ul-${key}-${j}`)}</li>)}
        </ul>
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      nodes.push(
        <ol key={key++} className="my-1 list-decimal pl-5 space-y-0.5">
          {items.map((item, j) => <li key={j}>{renderInline(item, `ol-${key}-${j}`)}</li>)}
        </ol>
      )
      continue
    }

    if (line.trim() === '') {
      i += 1
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    nodes.push(
      <p key={key++} className="my-1 whitespace-pre-wrap">
        {renderInline(para.join('\n'), `p-${key}`)}
      </p>
    )
  }

  return <>{nodes}</>
}
