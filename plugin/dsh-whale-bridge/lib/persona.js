/**
 * persona.md（桥接自定义人设）的读取与原子保存。
 *
 * 从 llm-proxy.js / bridge-server.js 的内联逻辑抽取，行为保持不变：
 * - loadPersonaFile：未配置 / 文件不存在 / 读取失败一律返回 ''，绝不抛异常；
 *   返回文件原文（不 trim），调用方按自己的语义 trim（新会话注入前 trim，面板展示保留原样）。
 * - savePersonaFile：先写 <file>.tmp 再 rename，避免写一半留下坏文件；
 *   长度上限 PERSONA_MAX_CHARS（与面板 PUT /api/persona 的 200000 限制一致）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 人设正文长度上限（字符数）：与面板保存接口、抽取前桥接的校验保持一致。 */
export const PERSONA_MAX_CHARS = 200000

/** persona.md 缺失时的默认人设（抽取前 llm-proxy.js 新会话注入的兜底文案）。 */
export const DEFAULT_PERSONA = '你是鲸鱼娘（小肥鱼），一只住在深海的鲸鱼女孩。'

/** settings.personaFile 的规范化路径；未配置返回 ''。 */
export function personaFilePath(settings) {
  return String((settings && settings.personaFile) || '').trim()
}

/**
 * 读取 settings.personaFile。
 * @param {object} settings 插件设置
 * @returns {string} 文件原文；未配置 / 不存在 / 读取失败返回 ''
 */
export function loadPersonaFile(settings) {
  try {
    const file = personaFilePath(settings)
    if (!file || !fs.existsSync(file)) return ''
    return String(fs.readFileSync(file, 'utf8') || '')
  } catch {
    return ''
  }
}

/**
 * 保存 settings.personaFile（tmp + rename 原子替换）。
 *
 * 不抛异常，统一返回结果对象，方便 HTTP 层按 code 映射状态码：
 * - NO_FILE   → 400 未设置 personaFile
 * - EMPTY     → 400 人设正文为空
 * - TOO_LONG  → 400 超过 PERSONA_MAX_CHARS
 * - IO        → 500 写入失败
 *
 * @param {object} settings 插件设置
 * @param {string} text 人设正文
 * @returns {{ok: true, path: string, length: number} | {ok: false, code: string, error: string}}
 */
export function savePersonaFile(settings, text) {
  const file = personaFilePath(settings)
  if (!file) return { ok: false, code: 'NO_FILE', error: '未设置 personaFile' }
  if (typeof text !== 'string' || !text) {
    return { ok: false, code: 'EMPTY', error: '人设正文为空' }
  }
  if (text.length > PERSONA_MAX_CHARS) {
    return { ok: false, code: 'TOO_LONG', error: '人设文本过长' }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, path: file, length: text.length }
  } catch (err) {
    return { ok: false, code: 'IO', error: String(err && err.message ? err.message : err) }
  }
}
