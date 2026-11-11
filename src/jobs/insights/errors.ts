/**
 * Thrown when the AI provider's daily free-tier quota is exhausted.
 * Callers should treat this as a terminal condition and stop processing.
 */
export class DailyQuotaExhaustedError extends Error {
  constructor(cause: string) {
    super(`Daily AI quota exhausted: ${cause}`)
    this.name = 'DailyQuotaExhaustedError'
  }
}
