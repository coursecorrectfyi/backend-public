/**
 * O*NET database seed — one-time Cloud Run Job (or local run with cloud-sql-proxy).
 *
 * Downloads the O*NET text bundle, parses the relevant files, and upserts into:
 *   onet_occupations, onet_skills, onet_job_zones, onet_wages
 *
 * Idempotent: safe to re-run when a new O*NET version is released.
 *
 * Usage:
 *   npm run onet:seed
 *
 * Env vars:
 *   DATABASE_URL  — postgres connection string (required)
 */

import 'dotenv/config'
import https from 'node:https'
import http from 'node:http'
import { createWriteStream, createReadStream, existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import * as XLSX from 'xlsx'
import { sql } from 'drizzle-orm'
import { db, closeDb } from '../../db/client.js'
import { onet_occupations, onet_skills, onet_job_zones, onet_wages } from '../../db/schema.js'
import { log } from '../../lib/logger.js'

const execAsync = promisify(exec)

const ONET_VERSION = '29_3'
const ONET_ZIP_URL = `https://www.onetcenter.org/dl_files/database/db_${ONET_VERSION}_text.zip`
const WORK_DIR = '/tmp/onet'
const ZIP_PATH = `${WORK_DIR}/onet.zip`
// The zip extracts to a subdirectory named after the version
const DATA_DIR = `${WORK_DIR}/db_${ONET_VERSION}_text`

// BLS Occupational Employment and Wage Statistics (OEWS) — national estimates.
// BLS blocks automated downloads. Download manually:
//   1. Go to https://www.bls.gov/oes/tables.htm → "All data" → XLSX
//   2. Place the file at this path and re-run npm run onet:seed
// Use the "National (XLSX)" file from https://www.bls.gov/oes/tables.htm — NOT "All data".
// "All data" includes all states + metros and is too large for the xlsx parser.
// National-only file is ~900 rows and parses in seconds.
const BLS_XLSX_PATH = `${WORK_DIR}/oesm24nat/national_M2024_dl.xlsx`

const BATCH_SIZE = 500

// ── Utilities ──────────────────────────────────────────────────────────────────

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const get = (u: string) => {
      const mod = u.startsWith('https') ? https : http
      const opts = new URL(u)
      mod.get({
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; onet-seed/1.0)' },
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          get(res.headers.location!)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', reject)
      }).on('error', reject)
    }
    get(url)
  })
}

async function parseTsv(filePath: string): Promise<Record<string, string>[]> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  const rows: Record<string, string>[] = []
  let headers: string[] = []

  for await (const line of rl) {
    if (!line.trim()) continue
    if (!headers.length) {
      headers = line.split('\t').map(h => h.trim())
      continue
    }
    const values = line.split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = (values[i] ?? '').trim() })
    rows.push(row)
  }
  return rows
}

async function batchUpsert<T>(
  label: string,
  items: T[],
  fn: (batch: T[]) => Promise<void>,
): Promise<void> {
  log({ event: 'onet_seed_start', table: label, count: items.length })
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    await fn(items.slice(i, i + BATCH_SIZE))
  }
  log({ event: 'onet_seed_done', table: label })
}

// ── Seeders ────────────────────────────────────────────────────────────────────

async function seedOccupations(): Promise<void> {
  const rows = await parseTsv(`${DATA_DIR}/Occupation Data.txt`)

  await batchUpsert('onet_occupations', rows, async (batch) => {
    await db.insert(onet_occupations).values(
      batch.map(r => ({
        soc_code: r['O*NET-SOC Code'],
        title: r['Title'],
        description: r['Description'] || null,
      }))
    ).onConflictDoUpdate({
      target: onet_occupations.soc_code,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
      },
    })
  })
}

async function seedSkills(): Promise<void> {
  const rows = await parseTsv(`${DATA_DIR}/Skills.txt`)

  // Only importance (IM) and level (LV) scales; skip suppressed entries
  const filtered = rows.filter(r =>
    (r['Scale ID'] === 'IM' || r['Scale ID'] === 'LV') &&
    r['Recommend Suppress'] !== 'Y'
  )

  await batchUpsert('onet_skills', filtered, async (batch) => {
    await db.insert(onet_skills).values(
      batch.map(r => ({
        soc_code: r['O*NET-SOC Code'],
        element_name: r['Element Name'],
        scale_id: r['Scale ID'],
        data_value: parseFloat(r['Data Value']),
      }))
    ).onConflictDoUpdate({
      target: [onet_skills.soc_code, onet_skills.element_name, onet_skills.scale_id],
      set: { data_value: sql`excluded.data_value` },
    })
  })
}

async function seedJobZones(): Promise<void> {
  const rows = await parseTsv(`${DATA_DIR}/Job Zones.txt`)

  // Deduplicate: keep one entry per SOC code (some codes appear under multiple job zones)
  const seen = new Set<string>()
  const deduped = rows.filter(r => {
    if (seen.has(r['O*NET-SOC Code'])) return false
    seen.add(r['O*NET-SOC Code'])
    return !!r['Job Zone']
  })

  await batchUpsert('onet_job_zones', deduped, async (batch) => {
    await db.insert(onet_job_zones).values(
      batch.map(r => ({
        soc_code: r['O*NET-SOC Code'],
        job_zone: parseInt(r['Job Zone'], 10),
      }))
    ).onConflictDoUpdate({
      target: onet_job_zones.soc_code,
      set: { job_zone: sql`excluded.job_zone` },
    })
  })
}

async function seedWages(): Promise<void> {
  if (!existsSync(BLS_XLSX_PATH)) {
    log({
      event: 'bls_wages_skipped',
      reason: `BLS XLSX not found — download "All data" XLSX from https://www.bls.gov/oes/tables.htm and place at ${BLS_XLSX_PATH}`,
    }, 'warn')
    return
  }

  log({ event: 'bls_parse_start', file: BLS_XLSX_PATH })
  const workbook = XLSX.read(readFileSync(BLS_XLSX_PATH))
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)

  // Keep only "detailed" rows — excludes aggregate groups like "15-0000 Computer Occupations"
  // BLS SOC code format: "15-1252" (no trailing .XX suffix)
  // '#' means BLS suppressed the value (too few respondents); treat as null.
  const blsByCode = new Map<string, { median: number | null; p10: number | null; p90: number | null }>()
  for (const r of rows) {
    if (String(r['O_GROUP'] ?? '').toLowerCase() !== 'detailed') continue
    const code = String(r['OCC_CODE'] ?? '').trim()
    if (!code) continue
    blsByCode.set(code, {
      median: parseWage(r['A_MEDIAN']),
      p10: parseWage(r['A_PCT10']),
      p90: parseWage(r['A_PCT90']),
    })
  }
  log({ event: 'bls_parse_done', detailed_occupations: blsByCode.size })

  // Map O*NET → BLS: strip the .XX specialization suffix ("15-1252.00" → "15-1252")
  // Multiple O*NET specializations (e.g. .01, .02) intentionally share the same BLS wage row.
  const onetCodes = await db.select({ soc_code: onet_occupations.soc_code }).from(onet_occupations)
  const toUpsert = onetCodes.flatMap(({ soc_code }) => {
    const blsCode = soc_code.replace(/\.\d+$/, '')
    const wages = blsByCode.get(blsCode)
    if (!wages) return []
    return [{
      soc_code,
      median_annual: wages.median,
      pct_10_annual: wages.p10,
      pct_90_annual: wages.p90,
      growth_rate: null as number | null,
      growth_category: null as string | null,
    }]
  })

  await batchUpsert('onet_wages', toUpsert, async (batch) => {
    await db.insert(onet_wages).values(batch).onConflictDoUpdate({
      target: onet_wages.soc_code,
      set: {
        median_annual: sql`excluded.median_annual`,
        pct_10_annual: sql`excluded.pct_10_annual`,
        pct_90_annual: sql`excluded.pct_90_annual`,
      },
    })
  })
}

function parseWage(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : parseInt(String(value).replace(/[^0-9]/g, ''), 10)
  return isNaN(n) ? null : n
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(WORK_DIR, { recursive: true })

  // Download zip (skip if already present for local re-runs)
  if (!existsSync(ZIP_PATH)) {
    log({ event: 'onet_download_start', url: ONET_ZIP_URL })
    await downloadFile(ONET_ZIP_URL, ZIP_PATH)
    log({ event: 'onet_download_done' })
  } else {
    log({ event: 'onet_download_skip', reason: 'zip already present' })
  }

  // Extract (skip if already extracted)
  if (!existsSync(DATA_DIR)) {
    log({ event: 'onet_extract_start' })
    await execAsync(`unzip -q "${ZIP_PATH}" -d "${WORK_DIR}"`)
    log({ event: 'onet_extract_done', dir: DATA_DIR })
  } else {
    log({ event: 'onet_extract_skip', reason: 'already extracted' })
  }

  try {
    // Order matters: occupations must be seeded before the FK-referencing tables
    await seedOccupations()
    await seedSkills()
    await seedJobZones()
    await seedWages()
    log({ event: 'onet_seed_complete' })
  } finally {
    await closeDb()
  }
}

main().catch(err => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      event: 'onet_seed_fatal',
      error: String(err),
    }) + '\n'
  )
  process.exit(1)
})
