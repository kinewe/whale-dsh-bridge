/**
 * 插件宿主对象：把设置存储、任务执行器、鲸鱼娘适配、OpenAI 代理和 HTTP 服务组装起来。
 * 注意：这里不依赖任何 @deepseek-ai/* 包，只用 Node 内置模块，便于跨 DSH 版本存活。
 */
import { appendLog, SettingsStore } from './config.js'
import { DshTaskRunner } from './dsh-task.js'
import { WhaleAdapter } from './whale-adapter.js'
import { FileChannel } from './file-channel.js'
import { LlmProxy } from './llm-proxy.js'
import { createBridgeServer } from './bridge-server.js'

export function createBridgeHost(_ctx, config) {
  const log = (line) => appendLog(line)
  const store = new SettingsStore(config || {})
  const runner = new DshTaskRunner(() => store.get(), log)
  const whale = new WhaleAdapter(() => store.get(), log)
  const files = new FileChannel({
    getSettings: () => store.get(),
    logger: log,
    getPort: () => store.get().port,
  })
  const proxy = new LlmProxy({
    getSettings: () => store.get(),
    runner,
    files,
    logger: log,
    saveSettings: (patch) => store.patch(patch),
  })
  const bridge = createBridgeServer({ store, runner, whale, proxy, files, log })
  whale.setOpenEvidenceWaiter(bridge.waitOpenEvidence)
  let disposed = false

  return {
    store,
    runner,
    whale,
    bridge,
    async start() {
      const settings = store.get()
      log(`[plugin] start port=${settings.port} workspace=${settings.workspace} whaleDir=${settings.whaleDir}`)
      try {
        const dirs = files.ensureDirs()
        log(`[files] dirs ready inbox=${dirs.inbox} outbox=${dirs.outbox} enabled=${files.enabled()}`)
      } catch (err) {
        log('[files] ensure dirs failed: ' + (err && err.message ? err.message : err))
      }
      // 额外缓存的定时清理（默认 7 天，跟随鲸鱼娘 storage.mediaKeepDays）
      try {
        files.cleanupOldBuffers()
      } catch (err) {
        log('[files] cleanup failed: ' + (err && err.message ? err.message : err))
      }
      try {
        const cleanupTimer = setInterval(() => {
          try {
            files.cleanupOldBuffers()
          } catch (err) {
            log('[files] cleanup failed: ' + (err && err.message ? err.message : err))
          }
        }, 6 * 3600 * 1000)
        if (cleanupTimer.unref) cleanupTimer.unref()
      } catch {
        /* ignore */
      }
      const result = await bridge.listen(settings.port)
      if (!result.ok) {
        // 端口被占用：尝试向后找可用端口，并把实际端口写回设置（面板/调试卡按设置里的端口访问）
        for (let i = 1; i <= 20; i += 1) {
          const alt = settings.port + i
          if (alt > 65535) break
          const retry = await bridge.listen(alt)
          if (retry.ok) {
            store.patch({ port: alt })
            log(`[plugin] port ${settings.port} busy, fallback to ${alt}`)
            break
          }
        }
      }
      // 任务 profile 预生成（不阻塞插件激活）
      runner.ensureProfile().catch((err) => log('[profile] ensure failed: ' + (err && err.message ? err.message : err)))

    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await bridge.close()
      } catch {
        /* ignore */
      }
      log('[plugin] disposed')
    },
  }
}
