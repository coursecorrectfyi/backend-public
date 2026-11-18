/**
 * Search evaluation CLI: npm run search:eval -- <command> [options]
 * How to use it: eval/search/README.md.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  calibrateScoreCommand, calibrateSampleCommand, compareCommand, judgeCommand, loadContext, reportCommand, runCommand,
} from './commands.js'
import { geminiJudge, parseJudgeSpec, PROMPT_VERSION, type JudgeConfig } from './judge.js'

const USAGE = `Usage: npm run search:eval -- <command> [options]

Commands:
  run --label <name>        run the golden queries through the API, add the reference (seed) runs
                            if missing, judge new results, print the report
      [--api <url>]         API to test (default http://localhost:3000)
      [--top-k <n>]         results kept per query (default 20)
      [--refresh-seeds]     re-run the reference rankers (after a catalogue change)
      [--no-judge]          don't call the judge (unjudged results count as not relevant)
      [--force]             replace an existing run with the same label
  judge                     judge pooled results that have no grade yet
  report [--runs a,b] [--focus <label>] [--out <file>]
                            compare runs (default: all) and list the weakest queries of --focus
  calibrate-sample [--n 60] [--seed 1] [--out <file>]
                            a blind sample of judged pairs for you to grade
  calibrate-score <file> [--judges spec1,spec2] [--save-overrides]
                            agreement between your grades and each judge (default: --judge)
  compare ["<query>"] [--params "sort=rating&level=beginner"] [--apis url1,url2] [--limit 5]
                            top results of each API side by side, for one query or (without one) every
                            query in queries.csv. Default APIs: http://localhost:3001 (e.g. the previous
                            search) and http://localhost:3000. Needs no database or credentials

Options for every command:
  --dir <dir>               where queries.csv, runs/ and judgments live (default: this folder)
  --judge <spec>            the judge: a Gemini model, optionally with a thinking budget, e.g.
                            gemini-2.5-pro or gemini-2.5-flash@thinking=0.
                            Default $SEARCH_EVAL_JUDGE or gemini-2.5-flash

Needs DATABASE_URL (run, judge, calibrate-*) and Google Cloud credentials with
Vertex AI (GOOGLE_CLOUD_PROJECT; embeddings for the semantic reference run, and the judge).`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      api: { type: 'string', default: 'http://localhost:3000' },
      'top-k': { type: 'string', default: '20' },
      'refresh-seeds': { type: 'boolean', default: false },
      'no-judge': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      runs: { type: 'string' },
      focus: { type: 'string' },
      out: { type: 'string' },
      n: { type: 'string', default: '60' },
      seed: { type: 'string', default: '1' },
      judges: { type: 'string' },
      'save-overrides': { type: 'boolean', default: false },
      dir: { type: 'string', default: dirname(fileURLToPath(import.meta.url)) },
      judge: { type: 'string', default: process.env.SEARCH_EVAL_JUDGE ?? 'gemini-2.5-flash' },
      help: { type: 'boolean', default: false },
      params: { type: 'string', default: '' },
      apis: { type: 'string', default: 'http://localhost:3001,http://localhost:3000' },
      limit: { type: 'string', default: '5' },
    },
  })
  const [command, ...args] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE + '\n')
    return
  }

  const note = (message: string) => process.stderr.write(message + '\n')
  parseJudgeSpec(values.judge) // fail early on a typo
  const judgeConfig: JudgeConfig = { model: values.judge, promptVersion: PROMPT_VERSION }
  const ctx = loadContext(values.dir, judgeConfig, note)
  const output = (text: string) => {
    if (values.out) { writeFileSync(values.out, text); note(`Written to ${values.out}`) }
    else process.stdout.write(text)
  }
  const makeJudge = (spec: string) => geminiJudge({ spec, project: requireEnv('GOOGLE_CLOUD_PROJECT') })

  if (command === 'compare') {
    const [query] = args
    const apis = values.apis.split(',').map(url => url.trim().replace(/\/$/, ''))
    output(await compareCommand({
      apis: apis.map(url => ({ label: url, fetchPath: path => fetch(url + path) })),
      rows: query ? [{ query, filters: values.params.replace(/^[?&]/, '') }] : ctx.rows,
      limit: Number(values.limit),
    }))
    return
  }

  if (command === 'report') {
    output(reportCommand(ctx, { runs: values.runs?.split(',').map(s => s.trim()), focus: values.focus }))
    return
  }

  // Everything else needs the database. Imported here so `report` works without one.
  requireEnv('DATABASE_URL')
  const { db, closeDb } = await import('../../src/db/client.js')
  const { embedQuery } = await import('../../src/lib/embedding/vertex.js')
  const { apiRetriever, keywordAnyRetriever, loadResources, semanticRetriever } = await import('./retrievers.js')
  const load = (ids: readonly string[]) => loadResources(db, ids)
  try {
    switch (command) {
      case 'run': {
        if (!values.label) throw new Error('run needs --label <name>, e.g. --label baseline')
        const api = values.api.replace(/\/$/, '')
        await runCommand(ctx, {
          label: values.label,
          api: apiRetriever(path => fetch(api + path), api),
          seeds: { keywordAny: keywordAnyRetriever(db), semantic: semanticRetriever(db, embedQuery) },
          loadResources: load,
          judge: values['no-judge'] ? null : makeJudge(judgeConfig.model),
          topK: Number(values['top-k']),
          refreshSeeds: values['refresh-seeds'],
          overwrite: values.force,
        })
        output(reportCommand(ctx, { focus: values.label }))
        break
      }
      case 'judge':
        await judgeCommand(ctx, { judge: makeJudge(judgeConfig.model), loadResources: load })
        break
      case 'calibrate-sample':
        output(await calibrateSampleCommand(ctx, { n: Number(values.n), seed: Number(values.seed), loadResources: load }))
        break
      case 'calibrate-score': {
        const [file] = args
        if (!file) throw new Error('calibrate-score needs the filled-in CSV file')
        const specs = values.judges ? values.judges.split(',').map(s => s.trim()) : [judgeConfig.model]
        specs.forEach(parseJudgeSpec)
        output(await calibrateScoreCommand(ctx, {
          csvText: readFileSync(file, 'utf8'),
          models: specs.map(spec => ({ config: { model: spec, promptVersion: PROMPT_VERSION }, judge: makeJudge(spec) })),
          loadResources: load,
          saveOverrides: values['save-overrides'],
        }))
        break
      }
      default:
        throw new Error(`Unknown command "${command}"\n\n${USAGE}`)
    }
  } finally {
    await closeDb()
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
