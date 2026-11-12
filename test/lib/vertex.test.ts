/**
 * src/lib/embedding/vertex.ts: the real module (the rest of the suite uses a fake).
 * Google auth and the Vertex REST endpoint are replaced with fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('../../src/lib/embedding/vertex.js')

const getAccessToken = vi.fn(async () => ({ token: 'fake-adc-token' }))
const GoogleAuth = vi.fn(function (this: unknown) {
  return { getClient: async () => ({ getAccessToken }) }
})
vi.mock('google-auth-library', () => ({ GoogleAuth }))

const { buildEmbeddingInput, embedBatch, embedQuery, EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS } =
  await import('../../src/lib/embedding/vertex.js')
// The auth client is created when the module loads. Vitest clears call history
// before each test (clearMocks), so record the constructor call now.
const googleAuthCalls = [...GoogleAuth.mock.calls]

const ENDPOINT =
  'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/text-embedding-004:predict'

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function prediction(values: number[], token_count = 5, truncated = false) {
  return { embeddings: { values, statistics: { token_count, truncated } } }
}
function sentBody(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call]![1]!.body as string)
}

beforeEach(() => {
  fetchMock.mockReset()
  getAccessToken.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

describe('module setup', () => {
  it('requests the cloud-platform scope and exports the index dimensions', () => {
    expect(googleAuthCalls).toEqual([[{ scopes: 'https://www.googleapis.com/auth/cloud-platform' }]])
    expect(EMBEDDING_DIMENSIONS).toBe(768)
    expect(EMBEDDING_BATCH_SIZE).toBe(100)
  })
})

describe('buildEmbeddingInput', () => {
  it('joins the fields with " | " and the skills with commas', () => {
    expect(buildEmbeddingInput({
      title: 'Deep Learning', provider_type: 'Specialization', institution: 'DeepLearning.AI',
      level: 'intermediate', skills: ['PyTorch', 'CNNs'], ai_summary: 'Neural nets from scratch.',
    })).toBe('Deep Learning | Specialization | DeepLearning.AI | intermediate | PyTorch, CNNs | Neural nets from scratch.')
  })

  it('leaves out null and empty fields', () => {
    expect(buildEmbeddingInput({
      title: 'Only Title', provider_type: null, institution: '', level: null, skills: [], ai_summary: null,
    })).toBe('Only Title')
  })
})

describe('embedQuery', () => {
  it('calls the Vertex predict endpoint with a RETRIEVAL_QUERY instance and an ADC bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ predictions: [prediction([0.1, 0.2])] }))
    await expect(embedQuery('learn sql')).resolves.toEqual([0.1, 0.2])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(ENDPOINT)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer fake-adc-token', 'Content-Type': 'application/json' },
    })
    expect(sentBody()).toEqual({ instances: [{ content: 'learn sql', task_type: 'RETRIEVAL_QUERY' }] })
  })

  it('throws with the status and a truncated body on an HTTP error (no retries)', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(1000), { status: 429 }))
    const err = await embedQuery('q').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(`Vertex AI embedding API 429: ${'x'.repeat(300)}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propagates credential errors without calling the API', async () => {
    getAccessToken.mockRejectedValueOnce(new Error('Could not load the default credentials'))
    await expect(embedQuery('q')).rejects.toThrow('Could not load the default credentials')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('embedBatch', () => {
  it('returns [] for no input without calling the API', async () => {
    await expect(embedBatch([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects more than EMBEDDING_BATCH_SIZE inputs', async () => {
    await expect(embedBatch(new Array(101).fill('x'))).rejects.toThrow('embedBatch: too many inputs (101 > 100)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends RETRIEVAL_DOCUMENT instances and maps the results in order', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ predictions: [prediction([1], 3), prediction([2], 2048, true)] }))
    await expect(embedBatch(['a', 'b'])).resolves.toEqual([
      { values: [1], tokenCount: 3, truncated: false },
      { values: [2], tokenCount: 2048, truncated: true },
    ])
    expect(sentBody()).toEqual({
      instances: [{ content: 'a', task_type: 'RETRIEVAL_DOCUMENT' }, { content: 'b', task_type: 'RETRIEVAL_DOCUMENT' }],
    })
  })

  it('retries after 1s then 2s, and succeeds if a retry works', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ predictions: [prediction([7])] }))

    const promise = embedBatch(['a'])
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toEqual([{ values: [7], tokenCount: 5, truncated: false }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up after 3 attempts with the last error', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async () => new Response('still busy', { status: 503 }))
    const promise = embedBatch(['a'])
    const assertion = expect(promise).rejects.toThrow(
      'Vertex AI embedding failed after 3 attempts: Vertex AI embedding API 503: still busy',
    )
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
