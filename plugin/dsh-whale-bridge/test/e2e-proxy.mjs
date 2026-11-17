/**
 * 代理 E2E 自检：假设 mock 上游在 8791、桥接宿主在 8790。
 * 验证：/v1/chat/completions → dsh_task → DSH 真的执行 → 结果回填 → 最终回复（非流式 + 流式）。
 */
const BRIDGE = 'http://127.0.0.1:8790'
const MOCK = 'http://127.0.0.1:8791'

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json, text }
}

const upstream = { baseUrl: MOCK, apiKey: 'mock-key', model: 'mock-chat' }
const saved = await jsonFetch(BRIDGE + '/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ brain: 'upstream', upstream }),
})
if (!saved.json.ok) {
  console.error('保存 upstream 失败', saved.json)
  process.exit(1)
}
console.log('OK settings.upstream =', saved.json.settings.upstream.baseUrl)

const messages = [
  { role: 'system', content: '你是鲸鱼娘。' },
  { role: 'user', content: '帮我去工作区看看前 5 个条目，然后用你的口吻告诉我。' },
]

// 1) 非流式
const nonStream = await jsonFetch(BRIDGE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'mock-chat', messages, stream: false }),
})
const content = nonStream.json?.choices?.[0]?.message?.content || ''
console.log('NONSTREAM', nonStream.status, '| len=', content.length)
console.log('NONSTREAM-CONTENT:', content.slice(0, 700))
if (!content.includes('DSH') || !content.includes('PROXY_REAL_DSH_OK')) {
  console.error('FAILED: 非流式回复里没有真实 DSH 工具结果（缺 PROXY_REAL_DSH_OK）')
  process.exit(1)
}

// 2) 流式 SSE
const res = await fetch(BRIDGE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'mock-chat', messages, stream: true }),
})
const sse = await res.text()
const deltas = sse.split(/\r?\n\r?\n/)
  .map((block) => block.trim())
  .filter((block) => block.startsWith('data:'))
  .map((block) => block.slice(5).trim())
  .filter((data) => data && data !== '[DONE]')
  .map((data) => {
    try {
      return JSON.parse(data)?.choices?.[0]?.delta?.content || ''
    } catch {
      return ''
    }
  })
  .join('')
console.log('STREAM', res.status, '| delta-len=', deltas.length)
console.log('STREAM-CONTENT:', deltas.slice(0, 700))
if (!deltas.includes('DSH') || !deltas.includes('PROXY_REAL_DSH_OK')) {
  console.error('FAILED: 流式回复里没有真实 DSH 工具结果（缺 PROXY_REAL_DSH_OK）')
  process.exit(1)
}

console.log('PROXY-E2E-PASS')
