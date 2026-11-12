export type ChatEvent =
  | { type: 'delta'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** Reads a Server-Sent Events response body and returns each `data:` payload parsed as JSON. */
export async function readSSE(res: Response): Promise<ChatEvent[]> {
  const text = await res.text()
  return text
    .split(/\n\n+/)
    .map(block => block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'))
    .filter(Boolean)
    .map(data => JSON.parse(data) as ChatEvent)
}
