# Search evaluation

Measures search quality on the real catalogue: how well the API ranks results for the golden queries in
[`queries.csv`](queries.csv), how often it finds nothing, how it handles typos, filters and nonsense, and how fast it
answers. The method and its reasoning are in [docs/search-decisions.md](../../docs/search-decisions.md#d15-measuring-the-evaluation-harness).
In short:
- results are **pooled** across rankers;
- each (query, result) pair is **graded 0–3 by an LLM judge** and stored;
- you **calibrate** the judge once on a blind sample.

Nothing here runs in production or ships in the Docker image.

## What you need

- **A database with the real catalogue and its embeddings**, e.g. the VM after the restore, or a restored copy.
  Readonly use only.
- **Google Cloud Application Default Credentials** with Vertex AI (`gcloud auth application-default login`) and
  `GOOGLE_CLOUD_PROJECT`. They're used for the query embeddings of the semantic reference ranker and for the judge.
- **The API under test running against that database.** Turn off the search rate limit, or the evaluation waits out
  `429`s:

  ```sh
  DATABASE_URL=... RATE_LIMIT_SEARCH_PER_MIN=0 npm run dev
  ```

## First time: the baseline

```sh
# 1. Run the golden queries through today's search, add the two reference rankers, judge everything, print the report.
DATABASE_URL=... npm run search:eval -- run --label baseline --out baseline-report.md

# 2. Calibrate the judge (about 30 minutes, once): a blind sample of 60 judged pairs.
DATABASE_URL=... npm run search:eval -- calibrate-sample --out calibration.csv
#    Open calibration.csv in a spreadsheet and fill in your_grade (0–3, rubric below) for each row.
#    Don't look up the judge's grade first.

# 3. Score the judge against your grades. Add other judges to compare them on the same labels: each grades only
#    the 60 labelled pairs (cents), and --save-overrides keeps your grades (they win over any judge).
DATABASE_URL=... npm run search:eval -- calibrate-score calibration.csv \
  --judges gemini-2.5-flash,gemini-2.5-pro --save-overrides
```

Then commit `runs/`, `judgments.jsonl` and `overrides.csv`. They're small, contain only catalogue data, and make later
runs cheap and reproducible.

**Reading the calibration.** "Same side of relevant" (both ≥ 2 or both < 2) matters most, since it decides precision.
As a rule of thumb:
- a weighted kappa above about 0.6 means the judge is usable for comparing rankers;
- low agreement on one kind of query means the rubric needs work for that kind: a new `PROMPT_VERSION` in `judge.ts`
  and a re-judge, not hand-labelling.

## After a search change

```sh
DATABASE_URL=... npm run search:eval -- run --label rrf-v1            # judges only the results no one has graded yet
npm run search:eval -- report --runs baseline,rrf-v1 --focus rrf-v1   # needs no database
```

Every report is recomputed from the current judgments and pool, so older runs stay comparable with newer ones. After
a catalogue refresh, add `--refresh-seeds` so the reference rankers see the new resources.

## The rubric (the judge's and yours)

Relevance only: how well the result matches what the learner is looking for, not how good or popular it is.

| Grade | Meaning |
|---|---|
| 3 | Highly relevant: its main subject is what the learner is looking for. If the search states a level ("for beginners"), a goal (a job, a certification) or a specific task, the result fits it |
| 2 | Relevant: covers it substantially, but broader, narrower or at another level than stated, or only part of what was asked |
| 1 | Marginal: mentions or touches on it, but a learner searching for this wouldn't choose it |
| 0 | Not relevant |

A job or career goal: relevant to the extent the result prepares for that role. A named certification: highly relevant
only if the result prepares for that certification.

## Commands

Run `npm run search:eval -- --help` for every option.

| Command | What it does | Needs |
|---|---|---|
| `run --label <name>` | The queries through the API (twice each: cold and warm timing, stability); the reference rankers if missing; judging; the report | database, API, Vertex AI |
| `judge` | Judges pooled results without a grade (e.g. after a `--no-judge` run, or with another `--judge`) | database, Vertex AI |
| `report [--runs a,b] [--focus <label>]` | Compares runs | nothing |
| `calibrate-sample [--n 60]` | Blind sample to grade | database |
| `calibrate-score <file> [--judges a,b] [--save-overrides]` | Agreement between you and each judge | database, Vertex AI for judges that haven't seen the pairs |
| `compare ["<query>"] [--params "sort=rating"] [--apis url1,url2]` | Top results of two APIs side by side (e.g. the previous search on :3001, this one on :3000), for one query or every query in `queries.csv`. For a quick manual look ([docs/search.md](../../docs/search.md#manual-beforeafter-check)) | the two APIs |

`--judge <spec>` chooses the judge for every command: a Gemini model, optionally with a thinking budget
(`gemini-2.5-flash`, `gemini-2.5-flash@thinking=0`, `gemini-2.5-pro`). The default is `$SEARCH_EVAL_JUDGE` or
`gemini-2.5-flash`. Judgments are stored per judge spec and prompt version, so switching judges re-judges the pool and
keeps the old grades apart.

## Files

| File | Contents |
|---|---|
| `queries.csv` | The golden queries: `query, kind, filters, expect, notes`. `filters` is a query string (`level=beginner&provider=edx`). `expect` is empty (judge the results), `none` (there should be no results), or `same_as:<query>` (a typo: judged as that query, and compared with its results) |
| `runs/<label>.json` | What one ranker returned per query, with timings. `seed-keyword-any` and `seed-semantic` are the reference rankers |
| `judgments.jsonl` | One judgment per line: query, resource (`provider:external_id`), grade, the judge's reason, judge, prompt version |
| `overrides.csv` | Human grades: `query, resource, grade, note`. Edit freely; they always win |

## What the report shows

| Metric | Meaning |
|---|---|
| nDCG@10 | How close the top 10 is to the best possible order of everything judged for the query (1 = perfect). Highly relevant results count much more than marginal ones (gain 2^grade − 1). Queries with nothing relevant in the pool are left out |
| P@10 | Share of the top 10 graded 2 or 3 (fewer than 10 results count as misses) |
| Queries without results | Excluding the nonsense rows. A query the catalogue can't answer also shows up here: check the per-query table |
| Nonsense without results | `expect=none` rows that correctly found nothing |
| Typos: overlap@10 | Share of the intended query's top 10 that the typo also finds |
| Results outside the filters, starved | Every result must satisfy the filters. "Starved": no results although relevant resources matching the filters exist |
| Unjudged top-10 results | Should be 0 (they count as not relevant). Run `judge` |
| Request times | From the evaluation machine, including the embedding call on the first request. The database's own time comes from `EXPLAIN (ANALYZE, BUFFERS)` on the server |
| Unstable | The repeat request returned different results |
| `as "…"` (per query) | The API corrected a typo: the query it searched instead |
| Semantic distance by grade | Cosine distances of judged results from the semantic reference run, per grade (p10, median, p90). Where to put `semantic.maxDistance`: above most distances of grades 2–3, below most of grade 0 |

**Cost** (approximate list prices, check current Vertex AI pricing):
- **First full run:** up to ~3,000 pairs. About $1–4 with Gemini 2.5 Flash, depending on how much it thinks, and
  roughly $20–25 with 2.5 Pro (it always thinks).
- **Later runs** judge only new results, usually a few hundred pairs.
- **Calibration comparison** of an extra judge: 60 pairs, well under $1.
