/** Search filters and their SQL. Shared by the API and the evaluation's reference rankers. */
import { eq, inArray, type SQL } from 'drizzle-orm'
import { learning_resources } from '../db/schema.js'

export const LEVELS = ['beginner', 'intermediate', 'advanced', 'all_levels'] as const
export const RESOURCE_TYPES = ['course', 'program', 'degree', 'project', 'certification', 'code_along'] as const

/** A filter with values keeps resources matching any of them; an unset boolean doesn't filter. */
export interface SearchFilters {
  level: string[]
  provider: string[]
  language: string[]
  resource_type: string[]
  is_free?: boolean
  has_certificate?: boolean
}

/** Names of the filters in use (for logs: never the values). */
export function filterNames(f: SearchFilters): string[] {
  return [
    ...(f.level.length ? ['level'] : []),
    ...(f.provider.length ? ['provider'] : []),
    ...(f.language.length ? ['language'] : []),
    ...(f.resource_type.length ? ['resource_type'] : []),
    ...(f.is_free !== undefined ? ['is_free'] : []),
    ...(f.has_certificate !== undefined ? ['has_certificate'] : []),
  ]
}

/** WHERE conditions: active resources matching the filters. */
export function filterConditions(f: SearchFilters): SQL[] {
  const lr = learning_resources
  return [
    eq(lr.is_active, true),
    ...(f.level.length ? [inArray(lr.level, f.level as never[])] : []),
    ...(f.provider.length ? [inArray(lr.provider, f.provider)] : []),
    ...(f.language.length ? [inArray(lr.language, f.language)] : []),
    ...(f.resource_type.length ? [inArray(lr.resource_type, f.resource_type as never[])] : []),
    ...(f.is_free !== undefined ? [eq(lr.is_free, f.is_free)] : []),
    ...(f.has_certificate !== undefined ? [eq(lr.has_certificate, f.has_certificate)] : []),
  ]
}
