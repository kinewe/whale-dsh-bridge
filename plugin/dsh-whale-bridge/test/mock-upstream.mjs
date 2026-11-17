/**
 * 假上游模型（仅用于 E2E 自检，不联网、不花钱）：
 * 第一次请求返回一个 dsh_task 工具调用；看到 role=tool 的消息后返回最终文本。
 * 用法：node test/mock-upstream.mjs [port]
 */
import http from 'node:http'

const port = Number(process.argv[2]) || 8791
let calls = 0

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    calls += 1
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      body = {}
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const systemText = messages.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n')
    const toolMessages = messages.filter((m) => m && m.role === 'tool')
    const hasToolResult = toolMessages.length > 0
    const isRouterCall = systemText.includes('检索路由器')
    let payload
    if (isRouterCall) {
      // 鲸鱼娘的「要不要联网」路由器：直接回答不需要联网，避免触发 DSH 任务
      payload = {
        id: 'mock-router',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"need":false}' }, finish_reason: 'stop' }],
      }
    } else if (!hasToolResult) {
      payload = {
        id: 'mock-1',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_mock_' + calls,
              type: 'function',
              function: {
                name: 'dsh_task',
                arguments: JSON.stringify({
                  instruction: '用 shell 执行 echo PROXY_REAL_DSH_OK，然后原样回答命令输出。',
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }
    } else {
      const toolText = String(toolMessages[toolMessages.length - 1].content || '')
      payload = {
        id: 'mock-2',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '（mock 上游）DSH 任务已执行。工具结果摘要：' + toolText.slice(0, 500),
          },
          finish_reason: 'stop',
        }],
      }
    }
    const text = JSON.stringify(payload)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log('[mock-upstream] listening on', port)
})
