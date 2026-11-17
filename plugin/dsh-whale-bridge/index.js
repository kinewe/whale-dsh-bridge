/**
 * dsh-whale-bridge —— 鲸鱼娘聊天壳 × DeepSeek Harness 桥接（Host 半侧）。
 *
 * Host 侧负责：
 *   1. 在 127.0.0.1:<port> 暴露桥接 HTTP API（DSH 侧边栏面板、鲸鱼娘 /debug 卡片使用）；
 *   2. 用 DSH headless CLI 执行「功能调用」类任务（whale-agent 任务 profile）；
 *   3. 提供 OpenAI 兼容代理，让鲸鱼娘 provider=custom 时经本代理按需进入 DSH 干活。
 *
 * 版本隔离：不 import 任何 @deepseek-ai/* 包，不改 DSH 安装目录；只依赖 CLI 契约与 profile 文件。
 * 浏览器半侧见同目录 client.js（由 package.json 的 dsh.client 声明）。
 */
import { createBridgeHost } from './lib/host.js'

export const name = 'dsh-whale-bridge'
export const inject = []

export function apply(ctx, config) {
  const host = createBridgeHost(ctx, config)
  ctx.effect(() => () => host.dispose())
  host.start().catch((err) => {
    console.error('[dsh-whale-bridge] 启动失败：', err)
  })
}
