/**
 * 本地自检宿主：在 DSH 之外单独拉起桥接插件（Host 半侧），用于 E2E 调试。
 * 用法：node test/manual-host.mjs [port]
 * 环境变量：可覆盖 DSH_WHALE_BRIDGE_EXE / DSH_WHALE_BRIDGE_CLI 指定 DSH 启动器。
 */
import { createBridgeHost } from '../lib/host.js'

const port = Number(process.argv[2]) || 8789
const workspace = process.env.WHALE_TEST_WORKSPACE || 'C:\\Dev_dsh'
const whaleDir = process.env.WHALE_TEST_WHALE_DIR || 'C:\\软件\\whale_girl\\whale-girl'
const host = createBridgeHost(null, {
  port,
  workspace,
  whaleDir,
})
await host.start()
console.log('[manual-host] started on port', host.bridge.getPort())
process.on('SIGINT', async () => {
  await host.dispose()
  process.exit(0)
})
