/**
 * Stand-in for src/lib/embedding/vertex.ts (Vertex AI text-embedding-004).
 *
 * By default embedQuery() returns unitVector(0). Tests can return specific
 * vectors to control vector ranking, or make it throw to simulate a Vertex outage.
 */
import { vi } from 'vitest'
import { singleton } from '../helpers/singleton.js'

export const EMBEDDING_DIMENSIONS = 768
export const EMBEDDING_BATCH_SIZE = 100

/** A 768-dimension vector with the given non-zero components, e.g. vec({ 0: 1, 1: 0.5 }). */
export function vec(components: Record<number, number>): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  for (const [i, value] of Object.entries(components)) v[Number(i)] = value
  return v
}

/** A unit vector along one axis. Vectors on different axes have cosine distance 1. */
export function unitVector(axis: number): number[] {
  return vec({ [axis]: 1 })
}

export const embedQuery = singleton('embedQuery', () =>
  vi.fn<(text: string) => Promise<number[]>>(),
)

export function resetEmbeddingFake(): void {
  embedQuery.mockReset()
  embedQuery.mockImplementation(async () => unitVector(0))
}

// The API only uses embedQuery. The batch helpers belong to the embedding job;
// fail loudly if API code ever starts calling them without a fake.
export function embedBatch(): never {
  throw new Error('embedBatch is not faked in the API test suite')
}
export function buildEmbeddingInput(): never {
  throw new Error('buildEmbeddingInput is not faked in the API test suite')
}
