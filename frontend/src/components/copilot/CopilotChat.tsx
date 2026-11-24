import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Send, Sparkles, Plus, MessageSquare, Trash2, ArrowLeft, Square, Copy, Check, FileText, X,
} from 'lucide-react'
import { auth } from '../../lib/auth'
import { useOrgStore } from '../../store/orgStore'
import api from '../../lib/api'
import renderMarkdown from './renderMarkdown'
import { chipsForRoute, pageLabelKeyForRoute } from './pageContext'

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  stopped?: boolean
}

interface Conversation {
  id: string
  title: string | null
  message_count: number
  updated_at: string
}

interface HistoryMessage {
  id: string
  role: string
  content: string
  created_at: string
}

interface CopilotChatProps {
  presentation?: 'floating' | 'sheet' | 'hidden'
  titleSlot?: ReactNode
  rightSlot?: ReactNode
  tools?: ReactNode
}

export default function CopilotChat({ presentation = 'floating', titleSlot, rightSlot, tools }: CopilotChatProps) {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const location = useLocation()

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const [contextAttached, setContextAttached] = useState(true)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const historyRequests = useRef<AbortController | null>(null)
  const conversationVersion = useRef(0)
  const stickToBottom = useRef(true)

  const labelKey = pageLabelKeyForRoute(location.pathname)
  const chipKeys = chipsForRoute(location.pathname)
  const pageContext = contextAttached && labelKey ? location.pathname : undefined

  // Reset conversation whenever the org changes.
  useEffect(() => {
    conversationVersion.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setInput('')
    setMessages([])
    setError('')
    setActiveConvId(null)
    setView('chat')
    setConversations([])
    return () => {
      conversationVersion.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [orgId])

  // Re-attach page context on navigation.
  useEffect(() => {
    setContextAttached(true)
  }, [location.pathname])

  useEffect(() => {
    if (presentation !== 'hidden') (inputRef.current ?? backRef.current)?.focus({ preventScroll: true })
  }, [presentation, view])

  useEffect(() => {
    const controller = new AbortController()
    historyRequests.current = controller
    if (orgId) {
      api
        .get<{ data: Conversation[] }>(`/orgs/${orgId}/ai/conversations`, { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) setConversations(res.data.data ?? []) })
        .catch(() => {/* history is optional */})
    }
    return () => {
      controller.abort()
      historyRequests.current = null
    }
  }, [orgId])

  // Autoscroll only while the user is at the bottom (spec §4.3 scroll pause).
  useEffect(() => {
    if (presentation !== 'hidden' && stickToBottom.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, busy, presentation])

  function onListScroll() {
    const el = listRef.current
    if (!el || presentation === 'hidden') return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  function startNewChat() {
    conversationVersion.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setMessages([])
    setActiveConvId(null)
    setView('chat')
    setError('')
  }

  async function resumeConversation(conv: Conversation) {
    if (!orgId) return
    startNewChat()
    const version = conversationVersion.current
    setActiveConvId(conv.id)
    setView('chat')
    setError('')
    try {
      // Messages come back newest-first (paged); take the latest page and
      // restore chronological order for the transcript.
      const { data: res } = await api.get<{ data: HistoryMessage[] }>(
        `/orgs/${orgId}/ai/conversations/${conv.id}/messages`,
        { params: { per_page: 200 }, signal: historyRequests.current?.signal },
      )
      if (version !== conversationVersion.current || useOrgStore.getState().currentOrg?.id !== orgId) return
      setMessages(
        (res.data ?? [])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .reverse()
          .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content })),
      )
    } catch {
      if (version === conversationVersion.current) setError(t('copilot.error'))
    }
  }

  async function deleteConversation(convId: string) {
    if (!orgId) return
    const version = conversationVersion.current
    try {
      await api.delete(`/orgs/${orgId}/ai/conversations/${convId}`, { signal: historyRequests.current?.signal })
      if (version !== conversationVersion.current || useOrgStore.getState().currentOrg?.id !== orgId) return
      setConversations((list) => list.filter((c) => c.id !== convId))
      if (activeConvId === convId) startNewChat()
    } catch {
      if (version === conversationVersion.current) setError(t('copilot.error'))
    }
  }

  function stopStreaming() {
    abortRef.current?.abort()
  }

  async function send(userText: string) {
    if (!orgId || busy) return
    const text = userText.trim()
    if (!text) return
    const version = ++conversationVersion.current
    const isCurrent = () => version === conversationVersion.current && useOrgStore.getState().currentOrg?.id === orgId
    setInput('')
    setError('')
    setBusy(true)
    stickToBottom.current = true
    setMessages((m) => [...m, { role: 'user', text }])

    const history: ChatMsg[] = [...messages, { role: 'user', text }]
    const assistantIndex = history.length

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/ai/copilot/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.getAccessToken() ?? ''}`,
        },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.text })),
          conversation_id: activeConvId,
          ...(pageContext ? { page_context: pageContext } : {}),
        }),
      })

      if (!isCurrent()) return
      if (!res.ok || !res.body) throw new Error('copilot request failed')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamed = ''

      while (true) {
        const { done, value } = await reader.read()
        if (!isCurrent()) { await reader.cancel(); return }
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const payload = JSON.parse(trimmed.slice(6))
          if (typeof payload.conversation_id === 'string' && !activeConvId) {
            setActiveConvId(payload.conversation_id)
          }
          if (typeof payload.delta === 'string') {
            streamed += payload.delta
            setMessages((m) => {
              const next = [...m]
              next[assistantIndex] = { role: 'assistant', text: streamed }
              return next
            })
          }
          if (payload.done) {
            setMessages((m) => {
              const next = [...m]
              if (!next[assistantIndex]) {
                next.push({ role: 'assistant', text: streamed || t('copilot.emptyReply') })
              }
              return next
            })
          }
        }
      }
    } catch (e) {
      if (!isCurrent()) return
      if (e instanceof DOMException && e.name === 'AbortError') {
        // Keep the partial reply, mark it stopped (interrupt-and-resume pattern).
        setMessages((m) => {
          const next = [...m]
          if (next[assistantIndex]) next[assistantIndex] = { ...next[assistantIndex], stopped: true }
          return next
        })
      } else {
        setError(t('copilot.error'))
        setMessages((m) => [...m, { role: 'assistant', text: t('copilot.error') }])
      }
    } finally {
      if (isCurrent()) {
        setBusy(false)
        abortRef.current = null
        // Refresh the conversation list (new titles/counts); history is optional.
        api
          .get<{ data: Conversation[] }>(`/orgs/${orgId}/ai/conversations`, { signal: historyRequests.current?.signal })
          .then((res) => { if (isCurrent()) setConversations(res.data.data ?? []) })
          .catch(() => {})
      }
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    send(input)
  }

  async function copyMessage(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="copilot-header">
        <h2 className="min-w-0 flex-1 font-semibold text-primary" aria-label={t('copilot.title')}>
          {titleSlot || <span className="flex items-center gap-2"><Sparkles size={17} className="text-accent" />{t('copilot.title')}</span>}
        </h2>
        <div className="flex items-center gap-0.5">
          {view === 'chat' && (
            <Button variant="ghost" shape="square"
              onClick={() => setView('history')}
              title={t('copilot.history')}
              aria-label={t('copilot.history')}
            >
              <MessageSquare size={15} />
            </Button>
          )}
          {view === 'chat' && (
            <Button variant="ghost" shape="square"
              onClick={startNewChat}
              title={t('copilot.newChat')}
              aria-label={t('copilot.newChat')}
            >
              <Plus size={15} />
            </Button>
          )}
          {rightSlot}
        </div>
      </div>
      {tools}

      {view === 'history' ? (
        <>
          <div className="flex items-center gap-2 px-5 py-3 border-b border-edge">
            <button
              ref={backRef}
              onClick={() => setView('chat')}
              className="flex items-center gap-1 text-xs text-secondary hover:text-primary transition-colors"
            >
              <ArrowLeft size={14} /> {t('copilot.back')}
            </button>
            <span className="text-xs text-muted">{t('copilot.history')}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {conversations.length === 0 && (
              <div className="text-sm text-secondary text-center py-10">
                {t('copilot.emptyHistory')}
              </div>
            )}
            {conversations.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 bg-subtle rounded-lg px-3 py-2 hover:bg-emphasis transition-colors"
              >
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => resumeConversation(c)}>
                  <span className="block text-sm text-primary truncate">{c.title ?? t('copilot.title')}</span>
                  <span className="block text-xs text-secondary">
                    {c.message_count} · {new Date(c.updated_at).toLocaleDateString()}
                  </span>
                </button>
                <Button variant="ghost" shape="square"
                  type="button"
                  onClick={() => deleteConversation(c.id)}
                  aria-label={t('copilot.deleteConversation')}
                  title={t('copilot.deleteConversation')}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Messages */}
          <div
            ref={listRef}
            onScroll={onListScroll}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 space-y-4"
          >
            {messages.length === 0 && (
              <div className="space-y-4">
                <p className="text-sm text-secondary leading-relaxed">{t('copilot.greeting')}</p>
                {!busy && <div className="flex flex-wrap gap-2">
                  {chipKeys.map((key) => (
                    <button key={key} onClick={() => send(t(key))}
                      className="rounded-md border border-edge px-2.5 py-1.5 text-left text-xs text-secondary hover:border-accent hover:text-accent">
                      {t(key)}
                    </button>
                  ))}
                </div>}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`group flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`min-w-0 max-w-[90%] break-words rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-accent text-on-accent'
                      : 'bg-subtle text-primary'
                  }`}
                >
                  {m.role === 'user' ? m.text : renderMarkdown(m.text)}
                </div>
                {m.role === 'assistant' && m.stopped && (
                  <span className="mt-1 text-[11px] text-muted">
                    ⏹ {t('copilot.stopped')}
                  </span>
                )}
                {m.role === 'assistant' && !m.stopped && (
                  <button
                    onClick={() => copyMessage(i, m.text)}
                    aria-label={t('copilot.copy')}
                    title={t('copilot.copy')}
                    className="mt-1 opacity-0 group-hover:opacity-100 focus:opacity-100 text-secondary hover:text-secondary transition-opacity"
                  >
                    {copiedIndex === i ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                )}
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div
                  role="status"
                  aria-label={t('copilot.thinking')}
                  className="bg-subtle rounded-xl px-4 py-3 flex gap-1"
                >
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 rounded-full bg-emphasis animate-pulse"
                      style={{ animationDelay: `${d * 150}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="px-5 py-2 bg-danger/10 border-t border-danger/25 text-danger text-xs">
              {error}
            </div>
          )}

          {/* Page-context pill */}
          {labelKey && contextAttached && (
            <div className="px-4 pb-2">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-soft border border-edge text-[11px] text-accent">
                <FileText size={11} />
                <span aria-label={t('copilot.context')}>{t(labelKey)}</span>
                <button
                  onClick={() => setContextAttached(false)}
                  aria-label={t('copilot.detachContext')}
                  title={t('copilot.detachContext')}
                  className="hover:text-accent"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <form onSubmit={handleSubmit} className="copilot-composer">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('copilot.placeholder')}
              aria-label={t('copilot.placeholder')}
              className="min-w-0 flex-1"
            />
            {busy ? (
              <button
                type="button"
                onClick={stopStreaming}
                aria-label={t('copilot.stop')}
                title={t('copilot.stop')}
                className="w-10 h-10 flex items-center justify-center bg-emphasis hover:bg-emphasis text-primary rounded-lg transition-colors"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label={t('copilot.send')}
                className="w-10 h-10 flex items-center justify-center bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors disabled:opacity-50"
              >
                <Send size={16} />
              </button>
            )}
          </form>
        </>
      )}
    </div>
  )
}
