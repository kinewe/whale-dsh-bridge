/**
 * 文件/任务进度话术（DSH 侧决定措辞，桥接只负责用 UIA 发出去）。
 *
 * 为什么在这里：桥接是微信唯一发送端，但「说什么」不该写死在桥接里。
 * 桥接收到文件事件时调用本插件 `/api/wechat/progress-line` 取一句话，
 * 由这里的鲸鱼娘人格模板决定措辞与语气；桥接拿到的只是文本。
 *
 * 以后若要连措辞都让 DSH 模型现生成，只需替换本模块的实现（多一次模型调用）。
 */

const TEMPLATES = {
  discovered: [
    '收到文件《{name}》{size}，我先取一下…',
    '《{name}》来了{size}，我这就看看。',
    '文件《{name}》{size}，等我一下哈。',
  ],
  image: [
    '收到一张图，我看看图里是什么…',
    '图收到了，我瞧瞧。',
    '收到图片，我这就看。',
  ],
  sticker: [
    '收到个表情包，我看看。',
    '哦，发表情包啦，我瞧瞧。',
    '表情包收到了，我看一眼。',
  ],
  waiting: [
    '《{name}》还在下载，再等我一会儿…',
    '大文件有点慢，我继续等着。',
    '还没落盘，我再等它一下…',
  ],
  fetched: [
    '拿到了，我看看里面是什么…',
    '文件到手，开始翻…',
    '好，拿到了，这就看。',
  ],
  working: [
    '我看看这个文件…',
    '正在翻这个文件…',
    '嗯，让我仔细看看…',
  ],
  processing: [
    '还在看这个文件，稍等一下…',
    '这个有点大，我再翻翻…',
    '正在处理，马上好…',
  ],
  failed: [
    '文件没取到，光看到名字…',
    '没拿到实体文件，你再发一次或者换个小文件？',
  ],
}

function pick(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return list[Math.floor(Math.random() * list.length)]
}

function fmtSize(sizeMB) {
  const n = Number(sizeMB)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1024) return '（' + (n / 1024).toFixed(1) + ' GB）'
  if (n >= 1) return '（' + n.toFixed(1) + ' MB）'
  return '（' + Math.max(1, Math.round(n * 1024)) + ' KB）'
}

/** 生成一句进度话术；未知事件返回空串（桥接就不发）。 */
export function progressLine(input = {}) {
  const event = String(input.event || '').trim()
  const list = TEMPLATES[event]
  if (!list) return ''
  const name = String(input.title || '').trim() || '文件'
  const size = fmtSize(input.sizeMB)
  let text = pick(list).replace('{name}', name).replace('{size}', size)
  // 等待超过 45 秒时带一句已等时间，避免主人以为卡死
  const waited = Number(input.waitedSec)
  if (event === 'waiting' && Number.isFinite(waited) && waited >= 45) {
    text = text.replace(/…$/, '') + '（已等 ' + Math.round(waited) + ' 秒）…'
  }
  return text.slice(0, 160)
}

export default { progressLine }
