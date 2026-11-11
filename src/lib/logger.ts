export function log(data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
  process.stdout.write(JSON.stringify({ level, ts: new Date().toISOString(), ...data }) + '\n')
}
