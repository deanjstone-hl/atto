const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
}
