const BACKEND_BASE = 'https://pc-backend.563838884.workers.dev'

export async function onRequest(context: EventContext<unknown, string, unknown>) {
  const { request } = context
  const url = new URL(request.url)
  const target = new URL(`${BACKEND_BASE}${url.pathname}${url.search}`)

  const headers = new Headers(request.headers)
  headers.set('Host', target.host)

  const init: RequestInit = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  }

  return fetch(target.toString(), init)
}
