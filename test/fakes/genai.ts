/**
 * Stand-in for @google/genai (Gemini on Vertex AI), used by the chat endpoint.
 *
 * generateContentStream is a vi.fn, so tests can inspect the model, conversation
 * history and system prompt it received. The reply is scripted with replyWith()
 * or failWith().
 */
import { vi } from 'vitest'
import { singleton } from '../helpers/singleton.js'

export interface GenerateContentRequest {
  model: string
  contents: Array<{ role: string; parts: Array<{ text: string }> }>
  config: { systemInstruction: string; temperature?: number; maxOutputTokens?: number }
}
type Chunk = { text: string | undefined }

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

async function* stream(chunks: Array<string | undefined>, error?: Error): AsyncGenerator<Chunk> {
  for (const text of chunks) yield { text }
  if (error) throw error
}

/** Stream these text chunks, then finish normally. */
export function replyWith(chunks: Array<string | undefined>): void {
  generateContentStream.mockImplementation(async () => stream(chunks))
}

/**
 * Simulate a Gemini failure: reject the request outright, or (when
 * afterChunks is given) fail partway through the stream.
 */
export function failWith(error: Error, opts: { afterChunks?: string[] } = {}): void {
  if (opts.afterChunks) {
    const chunks = opts.afterChunks
    generateContentStream.mockImplementation(async () => stream(chunks, error))
  } else {
    generateContentStream.mockRejectedValue(error)
  }
}

/** The last request chat.ts sent to Gemini. */
export function lastGeminiRequest(): GenerateContentRequest {
  const call = generateContentStream.mock.lastCall
  if (!call) throw new Error('Gemini was not called')
  return call[0]
}

export function resetGenaiFake(): void {
  generateContentStream.mockReset()
  replyWith(['Hello from Cora'])
}
