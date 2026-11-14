/** src/api/chat-generation.ts: Gemini output budget and the helpers that stop consuming a stream. */
import { describe, expect, it, vi } from 'vitest'
import {
  ANSWER_MAX_TOKENS, ClientDisconnected, GENERATION_TIMEOUT_MS, GenerationTimeout, MAX_OUTPUT_TOKENS, MODEL,
  TEMPERATURE, THINKING_BUDGET, TRUNCATION_NOTICE, abortable, untilAborted,
} from '../../src/api/chat-generation.js'

describe('settings', () => {
  // Documented in docs/api.md and chat-generation.ts: change them together.
  it('reserves 4,096 answer tokens on top of a 1,024-token thinking budget', () => {
    expect({ MODEL, TEMPERATURE, THINKING_BUDGET, ANSWER_MAX_TOKENS, MAX_OUTPUT_TOKENS, GENERATION_TIMEOUT_MS }).toEqual({
      MODEL: 'gemini-2.5-flash',
      TEMPERATURE: 0.7,
      THINKING_BUDGET: 1024,
      ANSWER_MAX_TOKENS: 4096,
      MAX_OUTPUT_TOKENS: 5120,
      GENERATION_TIMEOUT_MS: 120_000,
    })
  })

  it('tells the user how to continue when an answer is cut short', () => {
    expect(TRUNCATION_NOTICE).toMatch(/^\n\n_\(.*cut short.*Ask me to continue.*\)_$/)
  })

  it('names the abort reasons', () => {
    expect(new GenerationTimeout()).toMatchObject({ name: 'GenerationTimeout', message: 'Gemini did not finish within 120s' })
    expect(new ClientDisconnected()).toMatchObject({ name: 'ClientDisconnected' })
  })
})

describe('untilAborted', () => {
  it('resolves with the promise when it settles first', async () => {
    await expect(untilAborted(Promise.resolve(42), new AbortController().signal)).resolves.toBe(42)
  })

  it('passes on the promise rejection', async () => {
    await expect(untilAborted(Promise.reject(new Error('503')), new AbortController().signal)).rejects.toThrow('503')
  })

  it('rejects with the abort reason when the signal aborts first', async () => {
    const controller = new AbortController()
    const pending = untilAborted(new Promise(() => {}), controller.signal)
    const reason = new GenerationTimeout()
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('rejects at once when the signal has already aborted', async () => {
    const reason = new ClientDisconnected()
    await expect(untilAborted(new Promise(() => {}), AbortSignal.abort(reason))).rejects.toBe(reason)
  })
})

describe('abortable', () => {
  /** A source that yields `items`, then waits forever; records whether return() was called. */
  function source<T>(items: T[], opts: { stall?: boolean } = {}) {
    const calls = { returned: false }
    let i = 0
    const iterable: AsyncIterable<T> = {
      [Symbol.asyncIterator]: () => ({
        next: () => (i < items.length
          ? Promise.resolve({ value: items[i++]!, done: false })
          : opts.stall ? new Promise(() => {}) : Promise.resolve({ value: undefined, done: true as const })),
        return: () => {
          calls.returned = true
          return Promise.resolve({ value: undefined, done: true as const })
        },
      }),
    }
    return { iterable, calls }
  }

  it('yields every item and ends with the source, without calling return()', async () => {
    const { iterable, calls } = source([1, 2, 3])
    const seen: number[] = []
    for await (const n of abortable(iterable, new AbortController().signal)) seen.push(n)
    expect(seen).toEqual([1, 2, 3])
    expect(calls.returned).toBe(false)
  })

  it('rejects with the abort reason while the source is stuck, and tells the source to stop', async () => {
    const { iterable, calls } = source(['a'], { stall: true })
    const controller = new AbortController()
    const seen: string[] = []
    const run = (async () => { for await (const s of abortable(iterable, controller.signal)) seen.push(s) })()
    await vi.waitFor(() => expect(seen).toEqual(['a']))
    const reason = new GenerationTimeout()
    controller.abort(reason)
    await expect(run).rejects.toBe(reason)
    expect(calls.returned).toBe(true)
  })

  it('does not start when the signal has already aborted', async () => {
    const { iterable } = source([1])
    const seen: number[] = []
    const reason = new ClientDisconnected()
    await expect((async () => { for await (const n of abortable(iterable, AbortSignal.abort(reason))) seen.push(n) })())
      .rejects.toBe(reason)
    expect(seen).toEqual([])
  })

  it('passes on errors from the source', async () => {
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('connection reset')) }),
    }
    await expect((async () => { for await (const _ of abortable(failing, new AbortController().signal)) void _ })())
      .rejects.toThrow('connection reset')
  })

  it('tells the source to stop when the consumer stops early', async () => {
    const { iterable, calls } = source([1, 2, 3])
    for await (const n of abortable(iterable, new AbortController().signal)) if (n === 1) break
    expect(calls.returned).toBe(true)
  })

  it('copes with sources that have no return() or whose return() fails', async () => {
    const noReturn: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: 1, done: false }) }),
    }
    for await (const _ of abortable(noReturn, new AbortController().signal)) break
    const badReturn: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: 1, done: false }),
        return: () => Promise.reject(new Error('already closed')),
      }),
    }
    for await (const _ of abortable(badReturn, new AbortController().signal)) break
  })
})
