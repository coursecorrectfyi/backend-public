/**
 * Gemini generation settings for Cora, and helpers to stop consuming a stream.
 *
 * Output budget. On Gemini 2.5 models, thinking tokens count toward
 * maxOutputTokens and are billed as output. So the thinking budget is set
 * explicitly, and maxOutputTokens = thinking budget + answer allowance: the
 * visible answer always gets its full allowance, however much the model thinks.
 *
 * Answer allowance: 4,096 tokens. Estimated sizes of Cora's answers in her own
 * format (markdown, CourseCorrect links with UUIDs, which tokenize at about
 * 2 characters per token; prose at about 4):
 *   3 recommendations with links            ~250 tokens
 *   comparison table of 3 + pros/cons       ~950
 *   comparison table of 6 + pros/cons       ~1,650
 *   comparison table of 10 + pros/cons      ~2,600   (extreme case)
 * 4,096 leaves about 55% headroom over the extreme case. If an answer still
 * hits the limit, the user is told (TRUNCATION_NOTICE), and it is logged
 * (chat_answer, outcome "truncated") so the allowance can be tuned.
 *
 * Cancelling: the Gemini SDK notes that aborting a request is client-side
 * only and does not cancel (or un-bill) generation on Google's side. Aborting
 * still frees our Cloud Run request at once instead of holding it while the
 * rest of the answer streams to nobody.
 */

export const MODEL = 'gemini-2.5-flash'
export const TEMPERATURE = 0.7

/** Tokens Gemini may spend thinking before it answers. */
export const THINKING_BUDGET = 1_024
/** Tokens available for the visible answer. */
export const ANSWER_MAX_TOKENS = 4_096
/** Sent as maxOutputTokens: thinking and answer together. */
export const MAX_OUTPUT_TOKENS = THINKING_BUDGET + ANSWER_MAX_TOKENS

/**
 * Longest a whole answer may take, from the Gemini request until the last
 * chunk. A maximum-length answer normally finishes well within a minute.
 */
export const GENERATION_TIMEOUT_MS = 120_000

/** Appended (as a final delta) when an answer reached ANSWER_MAX_TOKENS. */
export const TRUNCATION_NOTICE =
  '\n\n_(This answer was cut short because it reached the maximum length. Ask me to continue, or narrow down the comparison.)_'

/** Abort reason when the generation took longer than GENERATION_TIMEOUT_MS. */
export class GenerationTimeout extends Error {
  constructor() {
    super(`Gemini did not finish within ${GENERATION_TIMEOUT_MS / 1000}s`)
    this.name = 'GenerationTimeout'
  }
}

/** Abort reason when the client closed the connection. */
export class ClientDisconnected extends Error {
  constructor() {
    super('client disconnected')
    this.name = 'ClientDisconnected'
  }
}

/** A promise that rejects with the signal's reason once it aborts. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  aborted.catch(() => {}) // only observed through Promise.race
  return aborted
}

/** Resolves like `promise`, or rejects with the signal's reason if it aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([promise, rejectOnAbort(signal)])
}

/**
 * Iterates `source` until it ends or `signal` aborts. On abort it rejects with
 * the abort reason straight away, even if the source is stuck waiting for its
 * next chunk, and asks the source to stop (return()), which closes the
 * underlying HTTP stream. This doesn't depend on the SDK honouring its own
 * abortSignal.
 */
export async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  const aborted = rejectOnAbort(signal)
  let finished = false
  try {
    for (;;) {
      // Checked explicitly as well: when both are already settled, Promise.race
      // picks the first in the array, so a ready chunk would win over an abort.
      signal.throwIfAborted()
      const next = await Promise.race([iterator.next(), aborted])
      signal.throwIfAborted()
      if (next.done) {
        finished = true
        return
      }
      yield next.value
    }
  } finally {
    // Not awaited: a stuck source may never settle its return().
    if (!finished) void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}
