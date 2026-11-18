# Search: decision record

Why search is built the way [search.md](search.md) describes: the problems it started from, what was found, the
options considered for each decision, and what was chosen. Written while building it in a sandbox, without production
data; the decisions that depend on data are marked, with what would change them.

## Where it started

The previous search, as the backlog described it:
- **Matching by keywords only, every word.** The embedding only re-ranked keyword matches.
- **Ranking:** 0.6 × `ts_rank` + 0.4 × cosine similarity. Two scales with untuned weights.
- **Problems this caused:**
  - "best python course for data analysis beginners", "learn to build websites" and "how to make a website" found
    nothing;
  - no typo tolerance;
  - `sort=rating` put a 5.0 from one rating above a 4.8 from 20,000;
  - resources without an embedding sank;
  - pages could skip or repeat results when the embedding failed between pages;
  - the cost grew with the number of keyword matches.

The target database is a 1 GB VM (self-managed Postgres 18, pgvector ≥ 0.8), which made cost bounds requirements.

## Measurements

Taken before this work on a copy of the production catalogue (~74k resources, 768-d embeddings):

| What | Result |
|---|---|
| Previous search, 2.3–5.7k all-words matches (a distance per match, read from TOAST), 1 GB VM | 71 ms avg, 142 ms max warm; up to ~1.8 s cold |
| Ranking ~5.7k matching rows (`python`) with `ts_rank_cd`, Cloud SQL | ~40–50 ms warm |
| Any-word matching of `data science`, `machine learning`, `project management` (24–32k rows each), ranked in full | 0.5–3 s cold, never fast, even on a managed instance |
| Single words with 2–4k matches | 35–70 ms warm |
| HNSW top-6 (chat) | ~2–4 ms |
| HNSW with default `ef_search` asked for 50 rows | returned 40 |
| `vector` → `halfvec` | index 288 → 144 MB, table 833 → 538 MB, no TOAST, cold search ~2× faster on the VM, top-6 results identical (60/60) |

## Findings from the sandbox

Checked with PGlite (Postgres 17.5, pgvector 0.8.0) and, for the driver, a real Postgres 16:
- **`vector` → `halfvec` is an implicit cast**, so the previous release's `::vector` queries work on a `halfvec`
  column and use its index. The reverse (a `::halfvec` literal against a `vector` column) silently scans the whole table.
- **An uncast parameter takes the column's type** (postgres.js sends strings untyped, also through Drizzle), so
  `embedding <=> $1` uses whichever index exists.
- **`ts_rank` has no IDF:** in an any-word query, a resource repeating "best course for beginners" outranked "Python
  for Data Analysis" (0.358 vs 0.314).
- **Trigrams miss swapped letters:** `similarity('pyhton', 'python')` = 0.27 and `phyton` = 0.17, below pg_trgm's
  default 0.3. Missing or extra letters score 0.5–0.8.
- **The English stemmer absorbs some typos** (`kubernets` and `kubernetes` → `kubernet`).
- **Both pgvector pitfalls from the backlog reproduce** with the index forced: `ef_search` caps a scan, and a rare
  filter starves without an iterative scan.
- **A distance in the SELECT list is computed from the heap row**, not from the index: a TOAST read per row with
  `vector`, free with `halfvec`.
- **On a small table the planner prefers `lr_is_active_idx`** (a boolean that's true for nearly every row) over the
  GIN index: see D18.
- **Through the production driver** (postgres.js against a real Postgres 16 with pg_trgm and fuzzystrmatch, vectors
  stubbed out), the search worked end to end in keyword mode: typo correction, vocabulary refresh, both tiers, all
  sorts and paging ([search.md, Tests](search.md#tests)).

## Decisions

Each: the question, the options, the choice, and what follows from it. "Data" marks choices to revisit with production
measurements ([search.md, "When a measurement calls for a code change"](search.md#when-a-measurement-calls-for-a-code-change)).

### D1. halfvec before the search work

- **Options:** halfvec first; or search first and halfvec later.
- **Chosen:** first.
- **Why:** the search is tuned and plan-tested on the final type and on the target VM, where `vector` barely fits.
  The semantic side's distance floor is free with `halfvec` (in-row) and a TOAST read per candidate with `vector`.
  And it's a separate, low-risk release.
- **Consequences:** migration `0007` rewrites the table under a lock, so it runs on the VM between restore and switch
  ([runbook](deployment-gcp.md#the-halfvec-migration-0007)).

### D2. Uncast vector parameters

- **Options:** `::vector` literals (as before); `::halfvec`; or uncast.
- **Chosen:** uncast.
- **Why:** the parameter takes the column's type, so one release works before and after the migration, with the index
  either way. A `::halfvec` literal on the old column would scan the whole table, silently.

### D3. Retrieval from both sides, merged by reciprocal rank fusion

- **Options:**
  - keyword filter plus semantic re-rank (the previous search);
  - a weighted sum of scores;
  - both sides retrieving, merged by RRF.
- **Chosen:** both sides retrieving, RRF with k = 60.
- **Why:** semantic matches can add results. RRF needs no score calibration between two scales, and it's standard and
  simple.
- **Consequences:** the result set is the union of two capped candidate lists (D9).

### D4. The keyword side: two tiers and a scan cap

- **Options:**
  - any word, everything ranked (measured too slow);
  - all words first, any word only when results are thin;
  - a capped candidate set, chosen arbitrarily, by a popularity prior (planner-dependent), or from a narrow side table.
- **Chosen:** all words, then any word if fewer than `candidates`. Each tier ranks at most `scanCap` (3,000; the
  measured budget was 2k–5k) matching rows, whichever the bitmap scan returns first.
- **Why:** simplest option that keeps cost bounded. For broad queries, the semantic side usually finds the obvious
  candidates anyway.
- **Data:** the evaluation's broad rows and the `scan_cap_hit` log field decide whether the arbitrary subset hurts.
  The alternatives are described for that case.

### D5. Generic catalogue words

- **Options:** a static list in config; derived at runtime from `pg_stats`' most common lexemes; or none.
- **Chosen:** static (`keyword.genericWords`), ignored unless the query has nothing else.
- **Why:** predictable and reviewable. The `pg_stats` route is clever but opaque, and depends on `ANALYZE`.
- **Data:** regenerate it from production with the query in [search.md](search.md#queries-for-tuning), and curate.

### D6. Ranking the any-word tier by coverage

- **Options:** `ts_rank_cd` alone; IDF weights from a word-statistics table; or coverage (how many query terms match)
  first.
- **Chosen:** coverage, then `ts_rank_cd`.
- **Why:** fixes the decoy found in the sandbox ("best course for beginners") without another maintained table. Together with generic words it's
  enough for the golden set.

### D7. The semantic distance floor

- **Options:** none; an absolute cutoff; relative to the best match. And for nonsense: return nothing, or "closest
  matches".
- **Chosen:** absolute `maxDistance` (0.5), plus an optional relative one (off). Nonsense returns nothing.
- **Why:** without a floor every query fills `candidates` results, so the zero-result rate means nothing.
- **Data:** the value is model-specific. Calibrate it with the evaluation's distance-by-grade table.

### D8. Resources without an embedding yet

- **Options:** plain RRF (they lose to anything found by both sides, even as the exact title match); or count their
  keyword rank for the semantic side too.
- **Chosen:** the latter, in hybrid mode only.
- **Why:** the window between ingestion and the embed job shouldn't bury exact matches. Resources that have an
  embedding but missed the semantic top-K get nothing from that side (standard RRF).

### D9. A result cap of ~200

- **Chosen:** the fused candidate list (at most `keyword.candidates + semantic.candidates`, 100 + 100).
- **Why:** bounded work per page. Few users page 10 times through relevance results.

### D10. Other sorts order the same results

- **Options:**
  - **S1:** sort the fused candidates;
  - **S2:** keep the all-words match set for other sorts, with no embedding (the previous behaviour).
- **Chosen:** S1. If the embedding fails, the keyword-only candidates are sorted, with `mode: 'keyword'` in the
  cursor, as for relevance.
- **Why:** empty results when switching the sort are worse than an extra embedding call, which is usually already
  cached by the relevance page (the frontend's default sort). The cost is bounded and no rating index is needed.
- **Consequences:**
  - this reverses the earlier changelog note that other sorts skip the semantic step;
  - `sort=newest` shows the newest of the ~200 most relevant results.

### D11. The weighted rating

- **Options:**
  - the raw average;
  - `rating × ln(num_ratings + 1)` (the insights job's formula, mostly popularity);
  - a Bayesian average.
- **Chosen:** a Bayesian average with one global prior (`rating.priorMean` 4.5, `priorCount` 50).
- **Where it's used:** `sort=rating`, and as the tiebreaker for equal relevance and within each candidate list.
- **Why:** it stays on the 0–5 scale, so it still means quality. `most_reviewed` already covers popularity.
- **Data:** set the prior from the catalogue (query in search.md). Per-provider priors and a relevance boost are
  possible code changes.

### D12. Cursors record the ranking mode

- **Chosen:** cursor version 2: `{ v: 2, sort, mode, values, id }`.
  - A keyword cursor continues without the embedding.
  - A hybrid cursor without one gets `503 search_unavailable`.
  - Older cursors get exactly `400 { "error": "Invalid cursor" }`.
- **Why the frontend can live with it:** it matches that 400 message and offers "Reload results". It retries a 5xx on
  "Load more" twice, then offers "Try again" with the same cursor.

### D13. Ordering and paging in TypeScript

- **Options:** in SQL per sort (as before); or in TypeScript over the candidates.
- **Chosen:** TypeScript.
- **Why:** at most ~200 candidates, one set of rules for every sort (NULLs last, id as the final tiebreaker), and
  testable without a database. Only the page's display fields are fetched. Timestamps carry microseconds as fixed-width
  text in cursors, which also removes a sub-millisecond keyset edge case of the previous search.

### D14. Typo tolerance

- **Options:**
  - a trigram index on titles (backlog suggestion);
  - rely on the embedding;
  - a vocabulary of catalogue words with trigram and edit-distance lookups.
- **Chosen:** the vocabulary (`search_vocabulary`).
  - **Which words:** only words that appear nowhere in the catalogue are replaced, since they match nothing anyway.
  - **Candidates:** trigrams, or the same first letter and a similar length (for swapped letters). Levenshtein limits
    by length (1 from 4 letters, 2 from 6).
  - **Choice among them:** closest, then most frequent, then alphabetical.
  - **Visibility:** returned as `corrected_query`.
  - **Freshness:** refreshed at the end of the embed job, and by `npm run search:vocabulary`. Ingestion and the embed
    job run manually today, with scheduling planned, so no new scheduled job.
- **Why:**
  - title trigrams miss transpositions and match whole titles poorly;
  - the embedding doesn't help when the embedding API is down, and its typo handling is unmeasured;
  - a vocabulary is small and exact.
- **Trade-off:** a real word the catalogue lacks can be corrected to a close one (`tableau` → `tables` in the test
  catalogue), pinned by a golden test. Any fuzzy matching has it: Elasticsearch's `fuzziness: AUTO` allows the same
  edits by length. The semantic side searches the corrected text too, which helps real typos, but loses the
  original word's meaning in that case. Embedding the original query instead is a one-line change, to decide with the
  evaluation's typo rows ([search.md](search.md#when-a-measurement-calls-for-a-code-change)).
- **Why a vocabulary table, and not "fuzzy" matching on the index itself:** Postgres full-text search matches whole
  lexemes exactly (and prefixes), with no edit distance, and pg_trgm compares whole strings, not the words of a
  document. pg_trgm's own documentation suggests this approach for spelling suggestions: a table of the words in the
  documents, searched by similarity. A search engine (Elasticsearch, OpenSearch, Meilisearch, Typesense) does the same
  internally, on the term dictionary it keeps anyway, so it needs no separate table and no refresh (D20).
- **Data:** the typo rows of the evaluation (and the semantic reference run: does the embedding absorb typos?).

### D15. Measuring: the evaluation harness

- **Options:** hand-picked "right answers" per query; click data (none yet); or pooled results graded by an LLM
  judge, calibrated against a human sample.
- **Chosen:** the last ([eval/search/README.md](../eval/search/README.md)).
- **Why:**
  - **Objective checks where possible:** zero results, nonsense, typo overlap, filters, latency, stability.
  - **Graded relevance (nDCG@10)** over a pool from several rankers, so new rankers aren't penalized for finding what
    the old one didn't.
  - **Stored judgments**, so runs are cheap and reproducible.
  - **A one-off blind calibration** instead of expert labelling.
- **Judge model:** Gemini 2.5 Flash by default. Flash vs Pro is decided during calibration:
  `calibrate-score --judges` lets both grade the same human-labelled pairs.
- **How reliable an LLM judge is:** published work (e.g. Bing's relevance labelling, TREC 2024 RAG) reports that LLM
  judgments rank *systems* in nearly the same order as human judgments, which is what this is for. Known weaknesses:
  - leniency;
  - possible bias toward systems built on the same model family (the embeddings are Google's too).

  The blind calibration sample is the guard. A second judge model can cross-check.
- **What "good" means for a query emerges over time.** It's the query's judged pool, ordered by grade. Every new
  ranker adds results to the pool, and popular queries get occasional human overrides. Later, with the analytics
  backlog item, queries many sessions searched (and zero-result ones) become golden queries, and outbound clicks and
  saves can confirm the judgments.
- **Not built, an option for more breadth:** known-item queries. An LLM writes the query a learner would type to find a
  sampled resource, which is then a known relevant result (MRR).

### D16. A `search` log line, counts only

- **Chosen now** (not with the analytics backlog item): one line per answered search with sort, mode, embedding use,
  page, results, filter names, keyword tier, candidate counts, `scan_cap_hit` and duration.
- **Never** the query text or the visitor's identity.
- **Why:** it gives the zero-result rate and everything production tuning needs, at no cost.

### D17. Chat retrieval unchanged

Pure vector top-k (k = 6, below the default `ef_search` of 40). Only its parameter became uncast (D2).

### D18. `lr_is_active_idx` kept, for now

On a small table the planner reads every row through it instead of using the GIN index (the plan tests leave it out
for that reason). On 74k rows that shouldn't happen, but only the VM's plans and `pg_stat_user_indexes` can tell.
Dropping it, or making it partial, is a migration to decide with that data.

### D19. How the tests stay meaningful without production data

- **Fake embedding:** knows a fixed list of concepts, with the title's concepts counting double, as the real
  embedding input starts with the title. No misspellings, so typo tolerance must come from the keyword side.
- **Determinism:** fixed ids, `ef_search` above the row count, planner statistics
  ([search.md, Tests](search.md#tests)).
- **Known bugs** were written first as `it.fails` golden tests and turned into `it` as they were fixed.

### D20. Staying on Postgres, not a search engine

- **Options:**
  - keep everything in Postgres (full-text search, pgvector, pg_trgm);
  - a dedicated search engine: Elasticsearch/OpenSearch (BM25, fuzzy matching, vectors), or Meilisearch/Typesense
    (typo tolerance and ranking rules built in);
  - BM25 extensions for Postgres: ParadeDB's `pg_search`, or RUM (ranked full-text scans from the index).
- **Chosen:** Postgres.
- **Why:**
  - One database on a 1 GB VM. Elasticsearch/OpenSearch alone want more memory than that.
  - No second store to keep in sync with the catalogue.
  - The tests run the real SQL on PGlite.
  - The catalogue (~74k resources) is small enough that bounded queries stay fast.
- **What a search engine would have given for free:**
  - BM25 ranking with word rarity (here: generic words and coverage, D5–D6);
  - top-k ranking from the index without reading every match (here: `scanCap`, D4);
  - typo tolerance without a vocabulary table and its refresh (D14).
- **When to revisit:**
  - if the evaluation shows broad queries or ranking quality limited by exactly those gaps;
  - or if the catalogue grows by an order of magnitude.

  ParadeDB or RUM keep everything in Postgres and become possible on a self-managed VM. PGlite can't load them,
  so the backlog item "run tests against real Postgres" comes first.

## History

| Step | What | Status |
|---|---|---|
| 0 | Golden set as failing tests | done |
| 1 | Evaluation harness, `search` log line | done |
| 2 | halfvec (`0007`), uncast parameters | done |
| 3 | Search module (`src/search/`), cursor v2 with the ranking mode | done |
| 4 | Both sides + RRF, generic words, scan cap, distance floor, missing-embedding rule, every sort on the same set | done |
| 5 | Weighted rating | done |
| 6 | Typo tolerance (vocabulary, `0008`), `corrected_query` | done |
| 7 | Tuning with production data, performance on the VM | to do: [search.md, "Tuning and rollout"](search.md#tuning-and-rollout) |
