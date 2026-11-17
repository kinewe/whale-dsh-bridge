/**
 * DSH text 流式转发的纯函数工具。
 *
 * 从 llm-proxy.js（completeDshChat 的 onText / 最终文本去重）抽取，行为保持不变：
 * - splitStreamText：把一段可见文本切成适合微信单条气泡的块；
 * - diffStreamText：DSH 文本是「累计全文」语义，算出相对上一次新增的片段；
 * - stripStreamedSegments / normalizeText / looseText：从最终回答里剥掉已流式发出的段落，
 *   并用宽松比较兜底判断「最终文本是否就是流式内容的重复」。
 *
 * 这些函数不依赖 LlmProxy 实例状态，可以独立测试/复用。
 */

/** 单条状态气泡的默认最大字符数（抽取前 _splitStreamText 的默认参数）。 */
export const STREAM_SPLIT_MAX_LEN = 180

/** 流式 SSE 分块大小（抽取前 streamDelta 里写死的 48）。 */
export const STREAM_DELTA_CHUNK_SIZE = 48

/**
 * 把一段可见文本切成适合微信单条气泡的块（只切 text 事件，不碰思考）。
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export function splitStreamText(text, maxLen = STREAM_SPLIT_MAX_LEN) {
  const s = String(text || '').trim()
  if (!s) return []
  if (s.length <= maxLen) return [s]
  const out = []
  let rest = s
  while (rest.length > maxLen) {
    let cut = -1
    for (const ch of ['。', '！', '？', '；', '\n', '，', ',']) {
      const idx = rest.lastIndexOf(ch, maxLen)
      if (idx > cut) cut = idx
    }
    if (cut < Math.floor(maxLen / 2)) cut = maxLen - 1
    out.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/**
 * DSH 的 text 事件是「本会话累计全文」：算出自上次以来新增的那一段。
 * 返回值里的 lastRawText 是供下一次调用传进来的新基准。
 * @param {string} raw 本次累计全文
 * @param {string} [lastRawText] 上一次累计全文
 * @returns {{piece: string, lastRawText: string}} piece 为空表示无需发送
 */
export function diffStreamText(raw, lastRawText = '') {
  const last = String(lastRawText || '')
  const clean = String(raw || '').replace(/\r/g, '').trim()
  if (!clean) return { piece: '', lastRawText: last }
  let piece = clean
  if (last) {
    if (clean.startsWith(last)) piece = clean.slice(last.length)
    else if (last.startsWith(clean)) return { piece: '', lastRawText: last }
  }
  // 只在更长（或等长）时更新基准，与抽取前保持一致
  const nextLast = clean.length >= last.length ? clean : last
  piece = piece.trim()
  if (!piece) return { piece: '', lastRawText: nextLast }
  return { piece, lastRawText: nextLast }
}

/**
 * 去掉空白后的比较基准。
 * @param {string} x
 * @returns {string}
 */
export function normalizeText(x) {
  return String(x || '').replace(/\s+/g, '')
}

/**
 * 更宽松的比较基准：去掉空白、标点、emoji/符号后再比，
 * 避免 🎉/✧ 被拆成单独气泡时误判重复。
 * @param {string} x
 * @returns {string}
 */
export function looseText(x) {
  return String(x || '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 从最终回答里逐个剥掉已经流式发出的片段（只删第一次出现的位置）。
 * @param {string} finalText
 * @param {string[]} segments
 * @returns {string} 剥掉片段后的文本（可能为空串）
 */
export function stripStreamedSegments(finalText, segments) {
  let strippedText = String(finalText || '')
  for (const seg of Array.isArray(segments) ? segments : []) {
    const piece = String(seg || '')
    if (!piece) continue
    const idx = strippedText.indexOf(piece)
    if (idx >= 0) strippedText = strippedText.slice(0, idx) + strippedText.slice(idx + piece.length)
  }
  return strippedText
}
