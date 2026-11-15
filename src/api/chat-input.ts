/**
 * Parsing and size limits for the POST /api/v1/chat request body.
 *
 * Everything in the body is client-controlled and ends up in a paid Gemini
 * request (and the message also in a paid embedding request), so every field
 * is bounded here. The public contract is documented in docs/api.md; keep the
 * two in sync.
 *
 * Only `message` is rejected when too long: it is what the user typed, so the
 * frontend can show the error next to the input. Everything else is context
 * the frontend assembles itself, so it is trimmed quietly and the chat still works.
 *
 * Lengths are String.length (UTF-16 code units), the same unit as the HTML
 * `maxlength` attribute, so a frontend `maxLength` of the same value matches
 * exactly.
 */

import { isLegacyMongoId, isUuid } from '../lib/ids.js'
import { collapseWhitespace, truncate } from '../lib/text.js'

export const CHAT_LIMITS = {
  /** Request body size. Larger bodies get 413 before they are parsed. */
  maxBodyBytes: 512 * 1024,
  /** Max length of `message` after trimming. Longer messages get 400. */
  messageMaxChars: 4_000,
  /** Only the most recent turns of `history` are used. */
  historyMaxTurns: 20,
  /**
   * Each history turn is cut to this length. Fits the longest answer Cora can
   * give (ANSWER_MAX_TOKENS in chat-generation.ts), so a previous answer is
   * never cut when it is sent back as history.
   */
  historyTurnMaxChars: 16_000,
  /** Total length of the history turns that are kept (newest first). */
  historyMaxChars: 32_000,
  /** Only the first N distinct, well-formed page context ids are used. */
  pageContextMaxIds: 50,
  /** `searchTerm` is cut to this length. */
  searchTermMaxChars: 200,
  /** Text sent to the embedding API for RAG retrieval is cut to this length. */
  ragQueryMaxChars: 4_000,
} as const

export const CURRENT_PAGES = ['SearchResult', 'SavedCourses', 'CourseDetail', 'SubjectPage'] as const
export type CurrentPage = typeof CURRENT_PAGES[number]

export interface HistoryTurn {
  role: 'user' | 'bot'
  content: string
}

export interface ChatInput {
  message: string
  pageContextIds: string[]
  currentPage: CurrentPage
  searchTerm: string | undefined
  history: HistoryTurn[]
}

export type ParseResult =
  | { ok: true; input: ChatInput }
  | { ok: false; error: Record<string, unknown> }

/**
 * Keeps well-formed turns, then the most recent ones that fit the turn and
 * character budgets. When older turns had to be dropped, the kept window
 * starts at a user turn, so it never opens with an answer whose question was
 * cut off.
 */
export function normalizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return []
  const valid = raw.filter(
    (t): t is HistoryTurn =>
      typeof t === 'object' && t !== null &&
      (t.role === 'user' || t.role === 'bot') &&
      typeof t.content === 'string',
  )

  const kept: HistoryTurn[] = []
  let chars = 0
  for (let i = valid.length - 1; i >= 0 && kept.length < CHAT_LIMITS.historyMaxTurns; i--) {
    const turn = valid[i]!
    const content = truncate(turn.content, CHAT_LIMITS.historyTurnMaxChars)
    if (chars + content.length > CHAT_LIMITS.historyMaxChars) break
    chars += content.length
    kept.unshift({ role: turn.role, content })
  }

  if (kept.length < valid.length) {
    while (kept.length > 0 && kept[0]!.role === 'bot') kept.shift()
  }
  return kept
}

/**
 * Keeps string ids in a format the API accepts (UUID or legacy MongoDB id),
 * drops duplicates and keeps the first CHAT_LIMITS.pageContextMaxIds.
 * Accepts the legacy `courseIds` field name via the caller.
 */
export function normalizePageContextIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids = raw.filter(
    (id): id is string => typeof id === 'string' && (isUuid(id) || isLegacyMongoId(id)),
  )
  return [...new Set(ids)].slice(0, CHAT_LIMITS.pageContextMaxIds)
}

/**
 * Collapses whitespace (including newlines, so the term can't add structure to
 * the system prompt it is quoted in), trims and cuts to the max length.
 */
export function normalizeSearchTerm(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const term = truncate(collapseWhitespace(raw), CHAT_LIMITS.searchTermMaxChars).trim()
  return term || undefined
}

/** Unknown or missing values fall back to 'SearchResult' (the previous default). */
export function normalizeCurrentPage(raw: unknown): CurrentPage {
  return CURRENT_PAGES.find(p => p === raw) ?? 'SearchResult'
}

/** Validates and normalizes a parsed JSON chat body. */
export function parseChatBody(body: Record<string, unknown>): ParseResult {
  const message = typeof body['message'] === 'string' ? body['message'].trim() : ''
  if (!message) {
    return { ok: false, error: { error: 'message is required' } }
  }
  if (message.length > CHAT_LIMITS.messageMaxChars) {
    return {
      ok: false,
      error: {
        error: `message must be at most ${CHAT_LIMITS.messageMaxChars} characters`,
        maxLength: CHAT_LIMITS.messageMaxChars,
      },
    }
  }

  return {
    ok: true,
    input: {
      message,
      // Accept both `pageContextIds` (new) and `courseIds` (legacy frontend) during transition.
      pageContextIds: normalizePageContextIds(body['pageContextIds'] ?? body['courseIds']),
      currentPage: normalizeCurrentPage(body['currentPage']),
      searchTerm: normalizeSearchTerm(body['searchTerm']),
      history: normalizeHistory(body['history']),
    },
  }
}

/**
 * Text to embed for RAG retrieval. Short messages ("give me the link", "tell
 * me more") carry weak semantic signal, so the last bot turn is appended: it
 * likely names the resource the user is following up on.
 */
export function buildRagQuery(message: string, history: HistoryTurn[]): string {
  const lastBotMessage = [...history].reverse().find(t => t.role === 'bot')
  const query = message.length < 60 && lastBotMessage
    ? `${message} ${lastBotMessage.content}`
    : message
  return truncate(query, CHAT_LIMITS.ragQueryMaxChars)
}
