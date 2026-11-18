/**
 * Stand-in for @google/genai (Gemini on Vertex AI), used by the chat endpoint.
 *
 * generateContentStream is a vi.fn, so tests can inspect the model, conversation
 * history and system prompt it received. The reply is scripted with replyWith(),
 * replyWithChunks(), failWith() or stallAfter().
 *
 * Like the real SDK, the stream stops with the abort reason once
 * config.abortSignal aborts. pulledChunks() tells how many chunks were consumed.
 */
import { vi } from 'vitest'
import { singleton } from '../helpers/singleton.js'

/** Schema constants are plain data: the real ones (used by the search eval's judge schema). */
export const { Type } = await vi.importActual<typeof import('@google/genai')>('@google/genai')

export interface GenerateContentRequest {
  model: string
  contents: Array<{ role: string; parts: Array<{ text: string }> }>
  config: {
    systemInstruction: string
    temperature?: number
    maxOutputTokens?: number
    thinkingConfig?: { thinkingBudget?: number }
    abortSignal?: AbortSignal
  }
}

/** One streamed chunk: the fields of GenerateContentResponse that chat.ts reads. */
export interface Chunk {
  text: string | undefined
  candidates?: Array<{ finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

export const generateContentStream = singleton('generateContentStream', () =>
  vi.fn<(req: GenerateContentRequest) => Promise<AsyncIterable<Chunk>>>(),
)

/** Options passed to `new GoogleGenAI(...)` (chat.ts creates its client once, at import). */
export const constructorOptions = singleton('genaiConstructorOptions', () => [] as unknown[])

export class GoogleGenAI {
  models = { generateContentStream }
  constructor(options: unknown) {
    constructorOptions.push(options)
  }
}

const state = singleton('genaiState', () => ({ pulled: 0 }))

/** How many chunks chat.ts has taken from the fake stream so far. */
export function pulledChunks(): number {
  return state.pulled
}

async function* stream(
  chunks: Chunk[],
  signal: AbortSignal | undefined,
  end: { error?: Error; stall?: boolean; ignoreAbort?: boolean } = {},
): AsyncGenerator<Chunk> {
  if (end.ignoreAbort) signal = undefined
  for (const chunk of chunks) {
    await new Promise(resolve => setImmediate(resolve)) // chunks arrive asynchronously, like a network stream
    if (signal?.aborted) throw signal.reason
    state.pulled++
    yield chunk
  }
  if (end.error) throw end.error
  if (end.stall) {
    // Wait for a chunk that never comes, until aborted (as the SDK's fetch would),
    // or forever when the abort signal is ignored.
    await new Promise((_, reject) => {
      if (signal?.aborted) reject(signal.reason)
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
}

const textChunks = (texts: Array<string | undefined>): Chunk[] => texts.map(text => ({ text }))

/** Stream these text chunks, then finish normally. */
export function replyWith(chunks: Array<string | undefined>): void {
  replyWithChunks(textChunks(chunks))
}

/** Stream these chunks (with finishReason / usageMetadata), then finish normally. */
export function replyWithChunks(chunks: Chunk[]): void {
  generateContentStream.mockImplementation(async req => stream(chunks, req.config.abortSignal))
}

/**
 * Simulate a Gemini failure: reject the request outright, or (when
 * afterChunks is given) fail partway through the stream.
 */
export function failWith(error: Error, opts: { afterChunks?: string[] } = {}): void {
  if (opts.afterChunks) {
    const chunks = textChunks(opts.afterChunks)
    generateContentStream.mockImplementation(async req => stream(chunks, req.config.abortSignal, { error }))
  } else {
    generateContentStream.mockRejectedValue(error)
  }
}

/**
 * Stream these text chunks, then hang (no more chunks, no end) until aborted.
 * With ignoreAbort, the stream also ignores the abort signal: a worst case the
 * app must still handle on its own.
 */
export function stallAfter(chunks: string[], opts: { ignoreAbort?: boolean } = {}): void {
  generateContentStream.mockImplementation(async req =>
    stream(textChunks(chunks), req.config.abortSignal, { stall: true, ignoreAbort: opts.ignoreAbort }))
}

/** The request hangs before the stream even starts, ignoring the abort signal. */
export function neverRespond(): void {
  generateContentStream.mockImplementation(() => new Promise(() => {}))
}

/** The last request chat.ts sent to Gemini. */
export function lastGeminiRequest(): GenerateContentRequest {
  const call = generateContentStream.mock.lastCall
  if (!call) throw new Error('Gemini was not called')
  return call[0]
}

export function resetGenaiFake(): void {
  generateContentStream.mockReset()
  state.pulled = 0
  replyWith(['Hello from Cora'])
}
