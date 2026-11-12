/** src/api/rag.ts: retrieveForQuery(), the vector retrieval used by chat. */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb } from '../fakes/db.js'
import { embedQuery, unitVector, vec } from '../fakes/embedding.js'
import { insertResource } from '../helpers/fixtures.js'
import { retrieveForQuery } from '../../src/api/rag.js'

beforeEach(resetDb)

describe('retrieveForQuery', () => {
  it('embeds the query and returns the k most similar active resources, closest first', async () => {
    embedQuery.mockResolvedValue(vec({ 0: 1 }))
    const exact = await insertResource({ title: 'Exact', embedding: vec({ 0: 1 }) })
    const close = await insertResource({ title: 'Close', embedding: vec({ 0: 0.9, 1: 0.1 }) })
    const far = await insertResource({ title: 'Far', embedding: vec({ 0: 0.1, 1: 0.9 }) })
    await insertResource({ title: 'Opposite', embedding: vec({ 0: -1 }) })

    const results = await retrieveForQuery('learn python', 3)
    expect(embedQuery).toHaveBeenCalledWith('learn python')
    expect(results.map(r => r.id)).toEqual([exact.id, close.id, far.id])
  })

  it('does not need a keyword match (pure semantic retrieval)', async () => {
    embedQuery.mockResolvedValue(unitVector(0))
    await insertResource({ title: 'Completely different words', embedding: unitVector(0) })
    expect(await retrieveForQuery('python', 5)).toHaveLength(1)
  })

  it('skips inactive resources and resources without embeddings', async () => {
    await insertResource({ title: 'Inactive', embedding: unitVector(0), is_active: false })
    await insertResource({ title: 'Not embedded', embedding: null })
    const ok = await insertResource({ title: 'OK', embedding: unitVector(0) })
    expect((await retrieveForQuery('q', 10)).map(r => r.id)).toEqual([ok.id])
  })

  it('excludes the given ids (resources already in page context)', async () => {
    const a = await insertResource({ embedding: unitVector(0) })
    const b = await insertResource({ embedding: unitVector(0) })
    const c = await insertResource({ embedding: unitVector(1) })
    const results = await retrieveForQuery('q', 10, [a.id, b.id])
    expect(results.map(r => r.id)).toEqual([c.id])
  })

  it('returns the fields chat needs to build its prompt', async () => {
    const insights = { reviewInsights: { sentiment: 'mixed' as const, pros: ['p'], cons: ['c'], representative_quotes: [] } }
    await insertResource({ title: 'T', ai_summary: 'S', skills: ['x'], ai_insights: insights, embedding: unitVector(0) })
    const [r] = await retrieveForQuery('q', 1)
    expect(Object.keys(r!).sort()).toEqual([
      'ai_insights', 'ai_summary', 'career_paths', 'duration_hours', 'has_certificate', 'id', 'institution',
      'is_free', 'is_self_paced', 'level', 'num_ratings', 'provider', 'rating', 'resource_type', 'skills', 'title',
    ])
    expect(r!.ai_insights).toEqual(insights)
  })

  it('returns an empty list when nothing is embedded', async () => {
    await insertResource({ embedding: null })
    expect(await retrieveForQuery('q', 6)).toEqual([])
  })

  it('throws when embedding fails (the caller decides how to degrade)', async () => {
    embedQuery.mockRejectedValue(new Error('Vertex AI embedding API 429'))
    await expect(retrieveForQuery('q', 6)).rejects.toThrow('Vertex AI embedding API 429')
  })
})
