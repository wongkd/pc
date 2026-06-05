// Pages Functions API proxy - 通过自定义域名转发请求到后端 Worker
// 避免 workers.dev 域名在国内被墙的问题

export async function onRequest(context: any) {
  const { request } = context
  const url = new URL(request.url)
  
  // 获取 /api/ 后面的路径
  const apiPath = url.pathname.replace(/^\/api/, '/api')
  const backendUrl = `https://pc-backend.563838884.workers.dev${apiPath}${url.search}`
  
  const headers = new Headers(request.headers)
  headers.set('Host', 'pc-backend.563838884.workers.dev')
  
  try {
    const response = await fetch(backendUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
    })
    
    const resHeaders = new Headers(response.headers)
    resHeaders.set('Access-Control-Allow-Origin', '*')
    
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message || '代理请求失败' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
}
