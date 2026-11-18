/**
 * Every tunable number and list of the search, in one place.
 *
 * The values are starting points chosen without production data. How to tune
 * each one, in which order, and which measurements would call for a code
 * change instead of a new value: docs/search.md, "Tuning". Change a value,
 * run the API locally against a copy of the catalogue, and compare with the
 * evaluation (eval/search/README.md) before releasing it.
 *
 * Tests use these same values, so a change that breaks a golden test
 * (test/api/search-golden.test.ts) changes behaviour the tests describe:
 * update the test only if the new behaviour is the intended one.
 */

export interface SearchConfig {
  keyword: {
    /** Keyword candidates that go into fusion (top N after ranking). */
    candidates: number
    /**
     * Matching rows read and ranked per keyword query, at most. Bounds the cost
     * of broad queries ("data science" matches a third of the catalogue): beyond
     * it, which matches get ranked is arbitrary (physical order). Measured budget:
     * ranking ~5.7k rows with ts_rank_cd ≈ 40–50 ms warm.
     */
    scanCap: number
    /** Query words used for keyword matching, in query order (a pasted paragraph doesn't become a 30-word AND/OR). */
    maxTerms: number
    /**
     * Words so common in a course catalogue that they only add noise ("best
     * python course"): left out of keyword matching, unless the query has
     * nothing else. Written as plain words; Postgres stems them like the query.
     */
    genericWords: readonly string[]
  }
  semantic: {
    /** Nearest neighbours taken from the HNSW index (hnsw.ef_search is raised to at least this). */
    candidates: number
    /**
     * hnsw.max_scan_tuples: how far an iterative index scan may go to find
     * `candidates` neighbours that pass the filters. Bounds the worst case of a
     * rare filter (each visited neighbour is checked against the filters).
     * Lower: faster worst case, fewer semantic matches for rare filters (keyword
     * matches are unaffected). 20,000 is pgvector's default.
     */
    maxScanTuples: number
    /**
     * Maximum cosine distance (1 − cosine similarity) of a semantic match.
     * Without it, every query, even nonsense, would get `candidates` results.
     * Model-specific: calibrate it with the evaluation's distance report.
     */
    maxDistance: number
    /**
     * Optional second floor, relative to the best match: drop matches farther
     * than the best one plus this. null = off. For when one absolute threshold
     * can't separate relevant from irrelevant matches across queries.
     */
    maxDistanceFromBest: number | null
  }
  fusion: {
    /** Reciprocal rank fusion constant: score = Σ 1 / (rrfK + rank). 60 is the usual value; lower favours top ranks more. */
    rrfK: number
  }
  rating: {
    /**
     * Weighted rating (Bayesian average): (n × rating + priorCount × priorMean) / (n + priorCount).
     * priorMean: the rating a resource is assumed to have before its reviews say
     * otherwise (≈ the catalogue's mean rating). priorCount: how many ratings
     * it takes for a resource's own average to count as much as the prior.
     */
    priorMean: number
    priorCount: number
  }
  typos: {
    /** Shorter query words are never corrected (too many near neighbours). */
    minWordLength: number
    /** Most edits (insertions, deletions, substitutions) allowed, by word length: the last entry whose minLength fits applies. */
    maxEdits: ReadonlyArray<{ minLength: number; edits: number }>
    /**
     * A correction must appear in at least this many active resources. 1 allows
     * correcting to a niche tool mentioned by a single course; raise it if
     * corrections land on words that are themselves typos in one title.
     */
    minDocCount: number
    /** pg_trgm similarity for the trigram half of the candidate lookup (the other half is same first letter and similar length). */
    trigramThreshold: number
  }
}

export const SEARCH_CONFIG = {
  keyword: {
    candidates: 100,
    scanCap: 3_000,
    maxTerms: 8,
    genericWords: [
      'course', 'courses', 'class', 'classes', 'tutorial', 'tutorials', 'lesson', 'lessons',
      'online', 'best', 'top', 'good', 'great', 'free', 'complete', 'ultimate',
    ],
  },
  semantic: {
    candidates: 100,
    maxScanTuples: 20_000,
    maxDistance: 0.5,
    maxDistanceFromBest: null,
  },
  fusion: {
    rrfK: 60,
  },
  rating: {
    priorMean: 4.5,
    priorCount: 50,
  },
  typos: {
    minWordLength: 4,
    maxEdits: [{ minLength: 4, edits: 1 }, { minLength: 6, edits: 2 }],
    minDocCount: 1,
    trigramThreshold: 0.3,
  },
} as const satisfies SearchConfig
