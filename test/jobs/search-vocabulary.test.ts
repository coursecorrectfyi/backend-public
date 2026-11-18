/** src/jobs/search-vocabulary.ts: the job entry point (refresh, log, exit code). */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, resetDb } from '../fakes/db.js'
import { insertResource } from '../helpers/fixtures.js'
import { captureLogs, errorLogs } from '../helpers/logs.js'
import { search_vocabulary } from '../../src/db/schema.js'
import { main } from '../../src/jobs/search-vocabulary.js'

beforeEach(resetDb)

describe('search-vocabulary job', () => {
  it('rebuilds the vocabulary, logs how many words, and exits 0', async () => {
    await insertResource({ title: 'Python Basics' })
    const logs = captureLogs()
    expect(await main()).toBe(0)
    expect((await db.select().from(search_vocabulary)).map(r => r.word).sort()).toEqual(['basics', 'python'])
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'search_vocabulary_refreshed', words: 2 }))
  })

  it('logs the failure for Error Reporting and exits 1', async () => {
    const logs = captureLogs()
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('connection lost'))
    expect(await main()).toBe(1)
    expect(errorLogs(logs(), 'search_vocabulary_failed')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('connection lost') }),
    ])
  })
})
