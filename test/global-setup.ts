/** Runs once before all test files: builds (or reuses) the migrated-database snapshot. */
import type { TestProject } from 'vitest/node'
import { buildSnapshot } from './fakes/pglite.js'

export default async function setup(project: TestProject) {
  project.provide('pgliteSnapshotPath', await buildSnapshot())
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgliteSnapshotPath: string
  }
}
