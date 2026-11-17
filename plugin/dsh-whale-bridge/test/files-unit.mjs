/**
 * 文件通道单元自检（不联网、不花额度）：
 *   node test/files-unit.mjs
 * 覆盖：MEDIA 提取、扩展名/大小/敏感路径校验、登记与下载链接、上传、路径穿越清洗、附件提示解析、
 *       配置项合并与归一化。
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { FileChannel, formatSize, isSensitivePath } from '../lib/file-channel.js'
import { applyPatch, normalize, DEFAULTS } from '../lib/config.js'
import { LlmProxy } from '../lib/llm-proxy.js'

const root = path.resolve('.files-unit-tmp')
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

let passed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓', name)
  } catch (err) {
    console.error('  ✗', name)
    throw err
  }
}

async function okAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓', name)
  } catch (err) {
    console.error('  ✗', name)
    throw err
  }
}

const settings = {
  ...normalize({ workspace: root, port: 8789, files: { enabled: true, autoOutbox: true, maxFileMB: 1, linkTtlHours: 24 } }),
}
const channel = new FileChannel({ getSettings: () => settings, logger: () => {}, getPort: () => 8789 })
const dirs = channel.ensureDirs()
console.log('# dirs', dirs)

console.log('\n[1] MEDIA 提取')
ok('单行 MEDIA 提取并清理文本', () => {
  const text = '报告写好了。\nMEDIA:C:\\ws\\outbox\\report.pdf\n以上。'
  const out = channel.extractMedia(text)
  assert.deepEqual(out.paths, ['C:\\ws\\outbox\\report.pdf'])
  assert.ok(!out.text.includes('MEDIA:'))
  assert.ok(out.text.includes('报告写好了'))
})
ok('多行/引号 MEDIA', () => {
  const out = channel.extractMedia('a\nMEDIA: "C:\\a b\\x.docx"\nMEDIA: `C:\\c\\y.png`\nMEDIA:C:\\d\\z.zip')
  assert.equal(out.paths.length, 3)
  assert.equal(out.paths[0], 'C:\\a b\\x.docx')
  assert.equal(out.paths[2], 'C:\\d\\z.zip')
})
ok('没有 MEDIA 时原样返回', () => {
  const out = channel.extractMedia('普通回复，没有文件。')
  assert.equal(out.paths.length, 0)
  assert.equal(out.text, '普通回复，没有文件。')
})

console.log('\n[2] 文件校验')
const outboxFile = path.join(dirs.outbox, 'sample.txt')
fs.writeFileSync(outboxFile, 'hello file channel')
ok('outbox 内文件可登记', () => {
  const v = channel.validateFile(outboxFile, { source: 'outbox', workspace: root })
  assert.equal(v.ok, true)
  assert.equal(v.size, 18)
})
ok('不存在的文件被拒', () => {
  const v = channel.validateFile(path.join(dirs.outbox, 'nope.txt'), { workspace: root })
  assert.equal(v.ok, false)
})
ok('不在 outbox 的文件不能按 outbox 收', () => {
  const outside = path.join(root, 'outside.txt')
  fs.writeFileSync(outside, 'x')
  const v = channel.validateFile(outside, { source: 'outbox', workspace: root })
  assert.equal(v.ok, false)
})
ok('非白名单扩展名被拒', () => {
  const bad = path.join(dirs.outbox, 'evil.unknownext')
  fs.writeFileSync(bad, 'x')
  const v = channel.validateFile(bad, { workspace: root })
  assert.equal(v.ok, false)
  assert.match(v.reason, /不允许的文件类型/)
})
ok('超大小被拒（maxFileMB=1）', () => {
  const big = path.join(dirs.outbox, 'big.txt')
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 10, 97))
  const v = channel.validateFile(big, { workspace: root })
  assert.equal(v.ok, false)
  assert.match(v.reason, /超过上限/)
})
ok('敏感路径被拒（DSH 数据目录 / 私钥名）', () => {
  assert.ok(isSensitivePath(path.join('C:\\Users\\example\\.dsh', 'x', 'settings.json')))
  assert.ok(isSensitivePath(path.join(dirs.outbox, 'id_rsa')))
  assert.ok(isSensitivePath(path.join(dirs.outbox, '.env')))
  assert.ok(!isSensitivePath(outboxFile))
})

console.log('\n[3] 登记与下载链接')
let registered
ok('register 返回 token/url（URL 用 ASCII 短名）', () => {
  const r = channel.register(outboxFile, { source: 'outbox', workspace: root })
  assert.equal(r.ok, true)
  registered = r.entry
  assert.match(registered.url, /^http:\/\/127\.0\.0\.1:8789\/files\/[a-f0-9]{32}\/file_[a-f0-9]{8}\.txt$/)
  assert.equal(registered.mime, 'text/plain; charset=utf-8')
})
ok('buildLinkBlock 含文件名与链接', () => {
  const block = channel.buildLinkBlock([registered])
  assert.match(block, /sample\.txt/)
  assert.ok(block.includes(registered.url))
  assert.match(block, /📎/)
})
ok('formatSize', () => {
  assert.equal(formatSize(18), '18 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
})

console.log('\n[4] 上传')
let uploaded
ok('正常上传落到 inbox', () => {
  const data = Buffer.from('上传内容 ABC', 'utf8').toString('base64')
  const r = channel.upload({ name: '聊天记录.txt', data })
  assert.equal(r.ok, true)
  uploaded = r.file
  assert.ok(uploaded.path.startsWith(dirs.inbox))
  assert.ok(fs.existsSync(uploaded.path))
  assert.equal(fs.readFileSync(uploaded.path, 'utf8'), '上传内容 ABC')
  assert.match(uploaded.hint, /\[Shared attachment\] file: /)
})
ok('上传非法扩展名被拒', () => {
  const r = channel.upload({ name: 'x.hack', data: Buffer.from('x').toString('base64') })
  assert.equal(r.ok, false)
})
ok('上传路径穿越被清洗到 inbox', () => {
  const r = channel.upload({ name: '../../evil.txt', data: Buffer.from('evil').toString('base64') })
  assert.equal(r.ok, true)
  assert.ok(r.file.path.startsWith(dirs.inbox))
  assert.ok(!r.file.path.includes('..'))
})
ok('上传 base64 为空被拒', () => {
  assert.equal(channel.upload({ name: 'a.txt', data: '' }).ok, false)
})
ok('关闭文件通道后拒绝上传', () => {
  const disabled = { ...settings, files: { ...settings.files, enabled: false } }
  const c2 = new FileChannel({ getSettings: () => disabled, logger: () => {}, getPort: () => 8789 })
  assert.equal(c2.upload({ name: 'a.txt', data: Buffer.from('x').toString('base64') }).ok, false)
})

console.log('\n[5] 入站附件提示')
ok('从消息提取 [Shared attachment]', () => {
  const text = '帮我看看这个文件\n\n[Shared attachment] file: ' + uploaded.path
  const list = channel.resolveAttachments([text], root)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, uploaded.name)
})
ok('不存在的附件路径被忽略', () => {
  const list = channel.resolveAttachments(['[Shared attachment] file: C:\\nope\\x.txt'], root)
  assert.equal(list.length, 0)
})
ok('伪造的附件 marker（目录外文件）被拒绝', () => {
  const outside = path.join(root, 'outside.txt')
  fs.writeFileSync(outside, '不该被当作附件')
  const list = channel.resolveAttachments(['[Shared attachment] file: ' + outside], root)
  assert.equal(list.length, 0)
})

console.log('\n[6] outbox 自动收集')
ok('快照后新增文件被收集', () => {
  const snapshot = channel.snapshotOutbox(root)
  const newer = path.join(dirs.outbox, 'new-report.md')
  fs.writeFileSync(newer, '# 新报告\n内容')
  const found = channel.collectNewOutbox(root, snapshot)
  assert.ok(found.some((f) => f.path.toLowerCase() === newer.toLowerCase()))
  assert.ok(!found.some((f) => f.path.toLowerCase() === outboxFile.toLowerCase()))
})

console.log('\n[7] 设置归一化 / 合并')
ok('normalize 填充 files 默认值', () => {
  const s = normalize({ workspace: root })
  assert.equal(s.files.enabled, true)
  assert.equal(s.files.maxFileMB, DEFAULTS.files.maxFileMB)
})
ok('handlePatch 局部更新 files 并夹取范围', () => {
  const cur = normalize({ workspace: root })
  const r = applyPatch(cur, { files: { enabled: false, maxFileMB: 9999 } })
  assert.equal(r.errors.length, 0)
  assert.equal(r.settings.files.enabled, false)
  assert.equal(r.settings.files.maxFileMB, 500)
  assert.equal(r.settings.files.autoOutbox, true)
})
ok('非法 files patch 报错', () => {
  const cur = normalize({ workspace: root })
  const r = applyPatch(cur, { files: 'nope' })
  assert.equal(r.errors.length, 1)
})

console.log('\n[7.5] 自环保护（upstream 不能指回桥接自身）')
ok('applyPatch 拒绝 upstream 指向桥接自身', () => {
  const cur = normalize({ workspace: root, port: 8789 })
  const r = applyPatch(cur, { upstream: { baseUrl: 'http://127.0.0.1:8789/v1', model: 'deepseek-chat' } })
  assert.ok(r.errors.some((e) => String(e).includes('不能指向桥接自身')))
  assert.notEqual(String(r.settings.upstream.baseUrl || ''), 'http://127.0.0.1:8789/v1')
})
ok('applyPatch 允许真实外部 upstream', () => {
  const cur = normalize({ workspace: root, port: 8789 })
  const r = applyPatch(cur, { upstream: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } })
  assert.equal(r.errors.length, 0)
  assert.equal(r.settings.upstream.baseUrl, 'https://api.deepseek.com/v1')
})

console.log('\n[8] LlmProxy 出站文件收集（fake runner，不调模型）')
await okAsync('任务期间 outbox 新文件自动登记并提示末尾附链接', async () => {
  const settings2 = normalize({ workspace: root, port: 8789, files: { enabled: true, autoOutbox: true, maxFileMB: 20 } })
  const channel2 = new FileChannel({ getSettings: () => settings2, logger: () => {}, getPort: () => 8789 })
  channel2.ensureDirs()
  const runner = {
    async runTask() {
      const f = path.join(root, '.whale-bridge', 'outbox', 'auto-out.txt')
      fs.writeFileSync(f, '自动收集的文件')
      return { ok: true, text: '任务完成，文件已生成', durationMs: 5, toolCalls: 1 }
    },
  }
  const proxy = new LlmProxy({ getSettings: () => settings2, runner, files: channel2, logger: () => {} })
  const turnFiles = []
  const call = await proxy.runToolCall(
    { id: 'c1', type: 'function', function: { name: 'dsh_task', arguments: JSON.stringify({ instruction: '生成文件' }) } },
    settings2,
    { turnFiles },
  )
  assert.match(call.content, /桥接会在最终回复末尾自动附上下载链接/)
  assert.equal(turnFiles.length, 1)
  assert.equal(turnFiles[0].name, 'auto-out.txt')
  const block = channel2.buildLinkBlock(turnFiles)
  assert.ok(block.includes('auto-out.txt'))
  assert.match(block, /\/files\/[a-f0-9]{32}\//)
})
await okAsync('DSH 文本里的 MEDIA: 被剥离并登记', async () => {
  const settings3 = normalize({ workspace: root, port: 8789, files: { enabled: true, autoOutbox: false, maxFileMB: 20 } })
  const channel3 = new FileChannel({ getSettings: () => settings3, logger: () => {}, getPort: () => 8789 })
  channel3.ensureDirs()
  const manual = path.join(root, '.whale-bridge', 'outbox', 'manual.txt')
  fs.writeFileSync(manual, '手工产物')
  const runner = {
    async runTask() {
      return { ok: true, text: `完成。\nMEDIA:${manual}\n以上。`, durationMs: 5, toolCalls: 1 }
    },
  }
  const proxy = new LlmProxy({ getSettings: () => settings3, runner, files: channel3, logger: () => {} })
  const turnFiles = []
  const call = await proxy.runToolCall(
    { id: 'c2', type: 'function', function: { name: 'dsh_task', arguments: JSON.stringify({ instruction: '产出文件' }) } },
    settings3,
    { turnFiles },
  )
  assert.ok(!call.content.includes('MEDIA:'), 'MEDIA 标记不应出现在给模型的结果里')
  assert.equal(turnFiles.length, 1)
  assert.equal(turnFiles[0].name, 'manual.txt')
})
await okAsync('相对路径的 MEDIA 被拒绝（必须绝对路径）', async () => {
  const settings4 = normalize({ workspace: root, port: 8789, files: { enabled: true } })
  const channel4 = new FileChannel({ getSettings: () => settings4, logger: () => {}, getPort: () => 8789 })
  const v = channel4.validateFile('AGENTS.md', { workspace: root })
  assert.equal(v.ok, false)
  assert.match(v.reason, /绝对路径/)
})
await okAsync('下载 Content-Disposition 用真实文件名（URL 短名不参与）', async () => {
  const settings5 = normalize({ workspace: root, port: 8789, files: { enabled: true } })
  const channel5 = new FileChannel({ getSettings: () => settings5, logger: () => {}, getPort: () => 8789 })
  channel5.ensureDirs()
  const named = path.join(root, '.whale-bridge', 'outbox', '季度报告 final.txt')
  fs.writeFileSync(named, 'report')
  const reg = channel5.register(named, { source: 'outbox', workspace: root })
  assert.equal(reg.ok, true)
  let writtenHeader = null
  const fakeRes = {
    writeHead(status, headers) { writtenHeader = headers },
    end() {},
  }
  const fakeReadStream = (p) => ({ on() {}, pipe() {} })
  const origCreate = fs.createReadStream
  fs.createReadStream = fakeReadStream
  try {
    channel5.serve({}, fakeRes, reg.entry.token, 'file_deadbeef.txt')
  } finally {
    fs.createReadStream = origCreate
  }
  assert.match(String(writtenHeader['Content-Disposition']), /filename\*=UTF-8''/)
  assert.ok(decodeURIComponent(String(writtenHeader['Content-Disposition']).split("filename*=UTF-8''")[1]) === '季度报告 final.txt')
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\nALL PASS (${passed} checks)`)
