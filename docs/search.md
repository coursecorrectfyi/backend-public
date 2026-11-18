# Search

How `GET /api/v1/resources/search` finds and orders resources, what can be tuned, and how to tune it. The API contract
(parameters, responses, errors) is in [api.md](api.md#get-apiv1resourcessearch). Why it's built this way, and the
options that were considered: [search-decisions.md](search-decisions.md).

**Status:** built and tested without production data. The values in `src/search/config.ts` are starting points.
Before the first release, follow [Tuning and rollout](#tuning-and-rollout), in order.

## How a search works

```
q ──► typo correction ──────────────► corrected text (shown to the client as corrected_query)
        │
        ├─► keyword terms ─► keyword candidates (GIN)    ─┐
        │                    tier 1: all terms             │
        │                    tier 2: any term, if too few  ├─► reciprocal rank fusion ─► order by sort ─► page after cursor
        └─► query embedding ─► semantic candidates (HNSW) ─┘      (≤ ~200 candidates)
            (cached)           nearest neighbours within the distance floor
```

| Step | File | What it does |
|---|---|---|
| HTTP | `src/api/resources.ts` | Reads and checks the input (400s), calls `search()`, maps the response, writes the `search` log line. |
| Orchestration | `src/search/search.ts` | The steps below, the ranking mode, the query-embedding cache. |
| Typo correction | `src/search/vocabulary.ts` | Query words that appear nowhere in the catalogue are replaced by the closest catalogue word (vocabulary table). |
| Keyword terms | `src/search/query.ts` | The query's lexemes (English stemming, as `search_document`), in query order, without generic words ("course", "best"…), at most 8. |
| Keyword candidates | `src/search/keyword.ts` | Tier 1: every term matches, ranked by `ts_rank_cd`. Tier 2 (only if tier 1 found fewer than wanted): any term, ranked by how many terms match, then `ts_rank_cd`. Each tier ranks at most `scanCap` matches. Ties: better weighted rating first. |
| Semantic candidates | `src/search/semantic.ts` | HNSW nearest neighbours of the query embedding, filters applied during the scan (iterative scan), within the distance floor. |
| Fusion | `src/search/fusion.ts` | Reciprocal rank fusion: Σ 1/(60 + rank). A resource without an embedding yet counts its keyword rank for the semantic side too. |
| Ordering, paging | `src/search/ordering.ts`, `cursor.ts` | Every sort orders the same candidates (TypeScript, NULLs last, id as the final tiebreaker). The cursor holds the last position and the ranking mode. |
| Filters | `src/search/filters.ts` | Filter SQL, shared with the evaluation. |
| Knobs | `src/search/config.ts` | Every number and word list above. |

**Ranking modes.** `hybrid` when the query embedding is available. `keyword` when the embedding API fails or times out
(`vector_search: false`).
- The cursor records the mode of page 1, and later pages keep it.
- A keyword cursor never calls the embedding API.
- A hybrid cursor whose embedding can't be computed gets `503 search_unavailable`. The frontend retries "Load more"
  with the same cursor. It's rare: page 1's embedding is cached on the instance.

**Every sort, same results.** `sort=rating` (and the others) order the fused candidates of the query, so switching the
sort never empties the list. The query is embedded for every sort, but the embedding is cached per instance, and the
frontend asks for relevance first. `rating` uses the weighted rating (Bayesian average, [below](#knobs)).

**At most ~200 results per search**: keyword candidates (100) + semantic candidates (100), fewer when they overlap.
That's about 10 pages of 20.

## Performance

Work per search is bounded by the knobs, not by how many resources match. Each search sends, in one connection:

| # | Statement | Index | Bound |
|---|---|---|---|
| 1 | Which query words the vocabulary knows | `search_vocabulary_pkey` | words in the query |
| 2 | Closest vocabulary word per unknown word (only if some are unknown; `SET LOCAL` for the trigram threshold) | `sv_word_trgm_idx`, `sv_first_letter_length_idx` | the vocabulary near each word |
| 3 | Keyword terms (no table) | — | — |
| 4 | Keyword tier 1 | `lr_search_document_idx` (GIN) | `scanCap` rows ranked |
| 5 | Keyword tier 2 (only if tier 1 found too few) | GIN | `scanCap` rows ranked |
| 6 | Semantic candidates (`SET LOCAL` ef_search, max_scan_tuples, iterative_scan) | `lr_embedding_hnsw_idx` | `candidates` neighbours, `maxScanTuples` scanned |
| 7 | Display fields of the page | primary key | page size |

Statements 4–6 run in one read-only transaction. Plus the query embedding when it isn't cached: one Vertex AI call,
cached per instance. `test/search/plans.test.ts` checks each statement can use its index.

**Measured before this work** (catalogue copy, ~74k resources; details in
[search-decisions.md](search-decisions.md#measurements)):
- Ranking ~5.7k matching rows with `ts_rank_cd`: ~40–50 ms warm (Cloud SQL).
- The previous search over 2.3–5.7k all-words matches, with a distance read from TOAST per match: 71 ms average,
  142 ms max warm on the 1 GB VM, up to ~1.8 s cold.
- Any-word matching of `data science` (24–32k rows), everything ranked: 0.5–3 s, which is why `scanCap` exists.
- HNSW top-6 (chat): ~2–4 ms.

These numbers predate the new search. It must be measured on the VM before release ([step 6](#tuning-and-rollout)).

## Knobs

All in `src/search/config.ts`, with comments. Tuning one is a value change, then a new evaluation run. The order below is the
order to tune them in.

| Knob | Default | What it controls | Tune it with |
|---|---|---|---|
| `semantic.maxDistance` | 0.5 | Semantic matches farther than this (cosine distance) are dropped. Too high: nonsense and vague queries fill pages with weak matches. Too low: good semantic matches are lost | The evaluation's "Semantic distance by grade" table; the nonsense rows |
| `semantic.maxDistanceFromBest` | off | Also drop matches farther than the best one plus this | Only if no single `maxDistance` works across queries |
| `keyword.genericWords` | course, best, online… | Words ignored for keyword matching (unless the query has nothing else) | [Query](#queries-for-tuning) for the most common words; the natural-language rows |
| `rating.priorMean`, `rating.priorCount` | 4.5, 50 | The weighted rating: `(n × rating + priorCount × priorMean) / (n + priorCount)` | [Query](#queries-for-tuning) for the catalogue's mean rating and rating counts |
| `keyword.candidates`, `semantic.candidates` | 100, 100 | How many candidates each side contributes (the result cap is their sum) | nDCG@10 vs latency |
| `fusion.rrfK` | 60 | Lower: top ranks of each side count more | nDCG@10; rarely worth changing |
| `keyword.scanCap` | 3,000 | Matching rows ranked per keyword tier. Beyond it, *which* matches get ranked is arbitrary | Latency of broad queries on the VM vs nDCG of the broad rows; `scan_cap_hit` in the logs |
| `keyword.maxTerms` | 8 | Query words used for keyword matching | Long pasted queries; rarely |
| `semantic.maxScanTuples` | 20,000 | How far an HNSW scan may go for a rare filter | Latency of rare filters (cold) vs the filtered rows' results |
| `typos.maxEdits`, `minWordLength`, `minDocCount`, `trigramThreshold` | 1 edit from 4 letters, 2 from 6; 1 resource; 0.3 | Which words get corrected, and how far | The typo rows; false corrections (see below) |

**Typo correction's trade-off.** A real word the catalogue lacks can be "corrected" to a close word it has.
`tableau` becomes `tables` in the test catalogue; the golden test pins this down.
- **Why it's allowed:** 2 edits from 6 letters are needed for common misspellings ("phyton" → "python").
  `corrected_query` lets the frontend show "Showing results for …".
- **What it affects:** only words that appear nowhere in the catalogue's text (titles, summaries, skills,
  institutions), so with real data it's mostly brand or tool names the catalogue doesn't cover. For those, the
  keyword side would have found nothing anyway.
- **The semantic side also searches the corrected text.** For a real typo that helps, if the embedding model doesn't
  absorb typos itself. For a real word the catalogue lacks, it loses what the original word meant.
- **What to measure before changing it:** the typo rows in the evaluation, and how often the `corrected` log field is
  true. Then tighten `maxEdits`, or embed the original query instead (a code change, in the table below).

## Operations

- **The vocabulary** (`search_vocabulary`) is derived from the catalogue.
  - It's rebuilt at the end of every embed job run, which runs after ingestion.
  - It can also be rebuilt on its own: `npm run search:vocabulary`.
  - While it's empty (after the migration, before the first refresh), typo correction is off and everything else works.
  - A refresh takes seconds and doesn't block searches (one transaction).
- **Before re-running ingestion and the embed job** (manual today): migrations `0007` and `0008` must be applied. The
  embed job needs the vocabulary table at its end. Order: ingestion → embed job (embeddings, then vocabulary) →
  insights (optional).
- **The `search` log line** ([operations.md §3b](operations.md#3b-search-logs)) has what tuning in production needs:
  - `mode`, `embedding` (cached, computed or failed), `results` (the zero-result rate), `corrected`;
  - `keyword_tier`, `keyword_candidates`, `semantic_candidates`, `scan_cap_hit`, `duration_ms`.

  Never the query text.
- **Watch monthly:**
  - the zero-result rate;
  - the share of `scan_cap_hit` (broad queries);
  - `embedding: failed` (Vertex AI health);
  - p95 `duration_ms`.

## Tests

| Tests | What they pin down |
|---|---|
| `test/api/search-golden.test.ts` | The behaviour, as golden queries over a 30-resource catalogue (`test/helpers/search-catalogue.ts`) with a fake embedding that knows a fixed list of concepts: natural language, typos, decoys, sorts, filters, pagination across ranking modes, `ef_search`, rare filters. Positions, not exact orders |
| `test/api/resources.test.ts` | The HTTP contract: validation, cursors, sorts and paging (with ties and NULLs), embedding calls, the log line |
| `test/search/*.test.ts` | Each step on its own: ordering, cursor, fusion, query terms, keyword tiers and cap, semantic floor and scan settings, vocabulary and correction, and the query plans |
| `test/eval/*.test.ts` | The evaluation harness |

**Determinism, by design.** These tests must give the same result on every run:
- **Ids.** Ties are broken by id, so tests either use fixed ids (the golden catalogue's ids come from the titles;
  `test/search` uses numbered ids), or compare against an order computed from the ids. The golden set was checked with
  three different id schemes, to catch tests that depend on how ties fall.
- **HNSW is approximate, and its graph differs per build.** Tests that force the index keep `ef_search` (100) above
  their row count, or let the iterative scan reach every row, so the results are exact.
- **Query plans:** a table of a few pages makes the planner choose differently from 74k rows. The plan tests use
  statistics, turn sequential scans off, and leave out `lr_is_active_idx` (see [Tuning](#when-a-measurement-calls-for-a-code-change)).
- **The eval's semantic reference ranker** ties many test resources at the same distance. Its tests assert what
  holds whatever the tie order.

**Checked once through the production driver.** The tests run on PGlite, whose driver differs from production's
(postgres.js). Before handover, the search was run once through postgres.js against a real Postgres 16 with
`pg_trgm` and `fuzzystrmatch`, but without pgvector (the vector column stubbed out):
- the vocabulary refresh and typo correction;
- both keyword tiers, and the keyword-only mode;
- the weighted rating, filters, and paging through all six sorts;
- the evaluation's keyword reference ranker.

All worked. Not covered there: the semantic query and its `SET LOCAL hnsw.*` settings (checked on PGlite, with the
driver's parameter typing checked on real Postgres). The first local run against the restored catalogue ([Tuning and
rollout](#tuning-and-rollout), step 1) exercises everything with the real driver.

**Adding a golden query:** add a resource to `CATALOGUE` if needed (its concepts must be in the fake embedding's
list), and write the test as a position ("in the top 3", "above X"). A known problem is `it.fails` with a `KNOWN BUG`
comment (README, Testing). A new query found in production also belongs in `eval/search/queries.csv`.

## Tuning and rollout

In this order. Steps 1–5 need a restored copy of the catalogue (or the VM before the switch) and Vertex AI credentials.
The evaluation is described in [eval/search/README.md](../eval/search/README.md).

0. **Database ready:** restore, migrations `0007` (halfvec, [runbook](deployment-gcp.md#the-halfvec-migration-0007))
   and `0008`, then `npm run search:vocabulary` and `ANALYZE`.
1. **Baseline of the previous search.** Check out the commit before this work, and run its API locally against the
   same database. It works on the migrated schema. Then `npm run search:eval -- run --label before`.
2. **Review the judge prompt** (`eval/search/judge.ts`) before anything is judged: its rubric is the definition of
   "relevant". Changing it later means a re-judge (a few dollars).
3. **This search, default knobs:** `run --label defaults`, then `report --runs before,defaults`. Look at a few
   queries by hand too: [Manual before/after check](#manual-beforeafter-check).
4. **Calibrate the judge** once: `calibrate-sample`, grade it, then
   `calibrate-score --judges gemini-2.5-flash,gemini-2.5-pro --save-overrides`. Keep the judge that agrees with you better.
5. **Tune the knobs** in the order of the [table](#knobs). Change one, restart the local API, `run --label <name>`,
   compare. Keep a change only if nDCG@10 and the zero-result rate don't get worse for any kind of query. Watch the
   weakest queries list.
6. **Performance on the VM**, cold and warm.
   - Cold: restart Postgres and drop the OS cache (`sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`), then run the
     evaluation. "First request" times are cold, "repeat" times warm. They include the embedding call, so compare with
     `duration_ms` in the API's logs.
   - For per-statement times, enable `pg_stat_statements`, or `auto_explain` with `auto_explain.log_min_duration`.
   - Budget: the previous search's 71 ms average and 142 ms max warm.
   - Broad queries (`data science`, `machine learning`) and rare filters are the ones to watch.
7. **Release:** changelog ([api.md](api.md#changelog)). Frontend:
   - `corrected_query` ("Showing results for …");
   - `503` on "Load more" is retried;
   - old cursors get `400 Invalid cursor` once, right after the deploy.
8. **After release:** the monthly checks in [Operations](#operations). Add real zero-result and popular queries
   (only those many sessions searched) to `queries.csv`, and judge them.

### Manual before/after check

The evaluation compares runs systematically. A manual look is still the quickest way to see what a change does, for a
few queries. Run the previous search and this one side by side against the same database, and compare their top
results.

The previous search can run against the migrated database: `0007` and `0008` are compatible with it.

```sh
# The previous search: a worktree of the commit before this work, on port 3001.
git worktree add ../backend-before <commit-before-the-search-work>
(cd ../backend-before && npm ci && PORT=3001 TRUST_PROXY_HOPS=0 RATE_LIMIT_SEARCH_PER_MIN=0 DATABASE_URL=... npm run dev) &
# This search, on port 3000.
PORT=3000 TRUST_PROXY_HOPS=0 RATE_LIMIT_SEARCH_PER_MIN=0 DATABASE_URL=... npm run dev &

# Top 5 of each, side by side (with the typo correction and ranking mode), for one query...
npm run search:eval -- compare "best python course for data analysis beginners"
npm run search:eval -- compare "python" --params "sort=rating"
# ...or for every query in eval/search/queries.csv (with their filters).
npm run search:eval -- compare --out compare.md
```

`compare` needs neither the database nor credentials, only the two running APIs (`--apis` to use others,
`--limit` for more results).

The queries from the original problem report, and a few more. "Before" is what the previous search did (measured on
the test database; check it on the real one with port 3001):

| Query | Before | Expected now |
|---|---|---|
| `best python course for data analysis beginners` | nothing | Python data analysis courses at the top |
| `learn to build websites` | nothing | Web development courses at the top |
| `how to make a website` | nothing | Web development and website builder courses (semantic matches) |
| `pyhton`, `phyton` | nothing | Python courses, `corrected to "python"` |
| `python`, `--params "sort=rating"` | a 5.0 from 1 rating above a 4.8 from 20,000 | Highly rated courses *with many ratings* first |
| `qwxzv blorp` | nothing | nothing (the distance floor) |
| an exact course title | that course first | that course first |
| `data science`, `machine learning` | data science / ML courses | the same or better; the log shows `scan_cap_hit` for these |
| `sql`, `--params "provider=edx&level=beginner"` | only edX beginner SQL courses | the same, not empty if any exist (rare filter) |
| a tool the catalogue doesn't cover | nothing | check `corrected to`: a false correction shows up here |

Add the queries you care about. A query that's clearly worse belongs in `eval/search/queries.csv` (and, if it shows a
behaviour worth pinning down, in the golden tests).

### Queries for tuning

```sql
-- Rating prior: the catalogue's mean rating, and typical rating counts. priorMean ≈ mean_rating; priorCount somewhere
-- between p25 and the median of num_ratings (how many ratings before a resource's own average should count as much as
-- the prior). Per provider too: if their means differ a lot, per-provider priors are a code change (below).
SELECT provider, count(*) AS rated, round(avg(rating)::numeric, 2) AS mean_rating,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY num_ratings) AS p25_ratings,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY num_ratings) AS median_ratings
FROM learning_resources WHERE is_active AND rating IS NOT NULL AND num_ratings > 0
GROUP BY ROLLUP (provider) ORDER BY provider NULLS FIRST;

-- Generic words: the most common lexemes (stemmed) and the share of resources containing them. Candidates for
-- keyword.genericWords are words people type that say nothing about the topic ("course", "online"). Never topic
-- words, however common ("data", "learn" as in "machine learning").
SELECT word, ndoc, round(100.0 * ndoc / (SELECT count(*) FROM learning_resources WHERE is_active), 1) AS pct
FROM ts_stat('SELECT search_document FROM learning_resources WHERE is_active')
ORDER BY ndoc DESC LIMIT 100;

-- How broad a query is: rows the keyword tiers would have to rank without scanCap.
SELECT count(*) FROM learning_resources
WHERE is_active AND search_document @@ plainto_tsquery('english', 'data science');

-- Is lr_is_active_idx ever used? (idx_scan since the statistics were reset)
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = 'learning_resources' ORDER BY idx_scan;
```

### When a measurement calls for a code change

Most findings are knob changes. These aren't. Each needs a decision, and a change that the golden tests and the
evaluation should then confirm.

| Finding | Why a knob won't do | Change to consider |
|---|---|---|
| Broad queries (`data science`, `machine learning`) score clearly below others, `scan_cap_hit` is frequent, and raising `scanCap` costs too much latency | Beyond the cap, which matches get ranked is arbitrary (the bitmap scan's physical order), so good title matches can be missed | Choose the capped rows by a prior instead: walk an index on popularity/weighted rating with the text match as a filter (the planner decides, so check its choices on the VM). Or move the ranked columns to a narrow side table (kept by a trigger) so ranking many rows stays cheap |
| The "Semantic distance by grade" table shows grades 0 and 2–3 overlapping at every threshold, and `maxDistanceFromBest` doesn't help | A single cutoff can't separate them | Per-query normalization (e.g. keep matches within N standard deviations of the best), or a re-ranker (LLM or cross-encoder) over the fused top 20–50 |
| Natural-language queries score low because tier 2 ranks an arbitrary `scanCap` subset of an any-word match (a common word in the query) | The subset is arbitrary, as above | "At least n−1 of n terms" before "any term" (a tsquery of OR'ed ANDs: small result sets), or more generic words |
| False typo corrections are common (e.g. brand names), and tightening `maxEdits` loses real typos | Edit distance can't tell them apart | Transposition-aware distance (swapped letters as 1 edit), and/or requiring the correction to be much more frequent than the original |
| The typo rows do well in the semantic reference run, and corrections add little | The embedding already absorbs typos | Embed the original query instead of the corrected one (one line in `search.ts`), so a real word the catalogue lacks keeps its meaning on the semantic side. Keep the correction for the keyword side and for keyword mode (embedding down) |
| Relevance's top results are often poorly rated, while equally relevant better ones sit lower | The weighted rating only breaks ties | Add a small prior to the fused score (a new knob in `fusion.ts`) |
| Provider ratings aren't comparable (different means) | One global prior | Per-provider `priorMean` |
| `lr_is_active_idx` shows up in search plans on the VM, or `idx_scan` shows it's never used | It indexes a boolean that's true for nearly every row | Drop it, or make it partial (`WHERE NOT is_active`) if something looks up inactive rows: a migration |
| p95 latency over budget with the knobs already lowered | Statement count and round trips | Run the keyword and semantic queries in parallel (two connections), merge statements, or cache whole first pages per query |
| Rare filters return few results and `maxScanTuples` is at its limit | The HNSW scan gives up | The planner can use the filter's own index for exact results (check its choice on the VM); otherwise a partial HNSW index per large provider |

## Known limitations

- **Generic words and the OR tier** work on stems. "course" and "courses" are both caught, but a generic word can't
  be ignored in one query and not another.
- **Result cap:** at most ~200 results per query for every sort, so `sort=newest` shows the newest of the ~200 most
  relevant results, not of every resource mentioning the words.
- **The vocabulary** is only as fresh as the last embed job or manual refresh. A refresh (or any catalogue change)
  between two pages of a search can change what later pages contain, as with any keyset pagination over changing data.
- **No query syntax** (quotes, `-word`): the query is plain text.
