#!/usr/bin/env node

/**
 * 灵溪识险 — Notion 开发日志同步脚本
 *
 * 用法：
 *   node scripts/notion-sync.js --title "修复案例匹配误判" --summary "关键词兜底把正常银行广告误判为高风险，已改为 LLM 返回 caseMatch 时不再启用关键词兜底" --tags "bug,案例匹配" --status "已完成"
 *
 * 前置条件：
 *   1. Notion Internal Integration 已创建并连接到目标数据库
 *   2. 在项目根目录创建 .notion-token 文件，内容为你的 Notion API Token
 */

const https = require('https')
const fs = require('fs')
const path = require('path')

// ============ 配置 ============

const DATABASE_ID = '3963182e8c6780bca18ff13b187023c6'
const TOKEN_FILE = path.join(__dirname, '..', '.notion-token')
const PAGE_CACHE_FILE = path.join(__dirname, '..', '.notion-sync-page-id')

// 目标页面 ID：内容直接写在这个页面上（不创建子页面）
// 例如 https://www.notion.so/开发日志-1a2b3c4d5e6f... → 填 "1a2b3c4d5e6f..."
const SYNC_PAGE_ID = process.env.NOTION_SYNC_PAGE_ID || ''

// 读取/写入页面 ID 缓存（文件 → 已创建的 Notion 页面 ID）
function loadPageCache() {
  try {
    if (fs.existsSync(PAGE_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(PAGE_CACHE_FILE, 'utf-8'))
    }
  } catch (_) { /* ignore */ }
  return {}
}
function savePageCache(cache) {
  fs.writeFileSync(PAGE_CACHE_FILE, JSON.stringify(cache, null, 2))
}

function loadToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
    if (!token) throw new Error('Token 文件为空')
    return token
  } catch (err) {
    console.error('❌ 未找到 Notion Token。请在项目根目录创建 .notion-token 文件，内容为你的 API Token。')
    console.error('   获取 Token: https://www.notion.so/profile/integrations')
    process.exit(1)
  }
}

// ============ Notion API 请求 ============

// 复用 HTTP Agent 以减少连接开销
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 })

function notionRequest(method, endpoint, body, retries = 3) {
  const token = loadToken()

  return new Promise((resolve, reject) => {
    let attempt = 0

    function doRequest() {
      const url = new URL(`https://api.notion.com/v1${endpoint}`)
      const data = body ? JSON.stringify(body) : undefined

      const options = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        agent: httpsAgent,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
      }

      const req = https.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          try {
            // 429 限流 → 重试
            if (res.statusCode === 429 && attempt < retries) {
              const delay = Math.pow(2, attempt) * 1000
              console.log(`   ⚠️ 限流，${delay/1000}s 后重试...`)
              setTimeout(() => { attempt++; doRequest() }, delay)
              return
            }
            // 5xx 服务端错误 → 重试
            if (res.statusCode >= 500 && attempt < retries) {
              const delay = Math.pow(2, attempt) * 500
              console.log(`   ⚠️ 服务端 ${res.statusCode}，${delay}ms 后重试...`)
              setTimeout(() => { attempt++; doRequest() }, delay)
              return
            }
            const json = JSON.parse(body)
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json)
            } else {
              reject(new Error(`Notion API ${res.statusCode}: ${json.message || body}`))
            }
          } catch (e) {
            reject(new Error(`JSON 解析失败 (${res.statusCode}): ${body.substring(0, 200)}`))
          }
        })
      })

      req.on('error', (err) => {
        // 网络错误 → 重试
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 500
          console.log(`   ⚠️ 网络错误: ${err.message}，${delay}ms 后重试...`)
          setTimeout(() => { attempt++; doRequest() }, delay)
        } else {
          reject(err)
        }
      })

      if (data) {
        req.setHeader('Content-Length', Buffer.byteLength(data))
        req.write(data)
      }
      req.end()
    }

    doRequest()
  })
}

// ============ 同步一条日志到 Notion ============

async function syncLog({ title, summary, tags, status, date }) {
  const properties = {
    // 标题列 — Notion 数据库默认的 Title 属性名
    '标题': {
      title: [{ text: { content: title || '未命名日志' } }],
    },
  }

  // 摘要（Text / Rich Text）
  if (summary) {
    properties['摘要'] = {
      rich_text: [{ text: { content: summary } }],
    }
  }

  // 日期
  properties['日期'] = {
    date: { start: date || new Date().toISOString().split('T')[0] },
  }

  // 标签（Multi-select，Notion 列名为"多选"）
  if (tags && tags.length > 0) {
    properties['多选'] = {
      multi_select: tags.map((name) => ({ name: name.trim() })),
    }
  }

  // 状态（Select）
  if (status) {
    properties['状态'] = {
      select: { name: status },
    }
  }

  console.log('📝 同步到 Notion...')
  console.log(`   标题: ${title}`)
  console.log(`   摘要: ${summary.substring(0, 50)}...`)
  console.log(`   标签: ${(tags || []).join(', ') || '无'}`)
  console.log(`   状态: ${status || '无'}`)

  const result = await notionRequest('POST', `/pages`, {
    parent: { database_id: DATABASE_ID },
    properties,
  })

  console.log(`✅ 同步成功！Notion 页面 ID: ${result.id}`)
  console.log(`   URL: ${result.url}`)
  return result
}

// ============ 诊断：查看数据库真实属性 ============

async function diagnose() {
  const result = await notionRequest('GET', `/databases/${DATABASE_ID}`)
  const props = result.properties
  console.log('🔍 Notion 数据库属性列表:\n')
  for (const [name, def] of Object.entries(props)) {
    console.log(`   名称: "${name}"  类型: ${def.type}${def.type === 'select' ? ' (选项: ' + def.select.options.map(o => o.name).join(', ') + ')' : ''}${def.type === 'multi_select' ? ' (选项: ' + def.multi_select.options.map(o => o.name).join(', ') + ')' : ''}${def.type === 'status' ? ' (选项: ' + def.status.options.map(o => o.name).join(', ') + ')' : ''}`)
  }
  console.log('')
}

// ============ 查询最近日志（调试用） ============

async function listRecent(limit = 5) {
  // 先获取数据库属性，找到 title 列的真实名称
  const dbInfo = await notionRequest('GET', `/databases/${DATABASE_ID}`)
  const titleProp = Object.entries(dbInfo.properties).find(([, v]) => v.type === 'title')
  const titleKey = titleProp ? titleProp[0] : 'Name'

  const result = await notionRequest('POST', `/databases/${DATABASE_ID}/query`, {
    page_size: limit,
    // 不排序，避免属性名不匹配问题
  })

  console.log(`📋 最近 ${limit} 条日志:`)
  for (const page of result.results) {
    const title = page.properties[titleKey]?.title?.[0]?.plain_text || '(无标题)'
    console.log(`   - ${title}`)
  }
}

// ============ Markdown → Notion Blocks 转换 ============

// 行内格式解析：**bold**, `code`, [text](url) → Notion rich_text[]
const INLINE_MD_RE = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;

function parseInlineMarkdown(text) {
  // 快速路径：不含任何 markdown 语法则直接返回
  if (!text.includes('**') && !text.includes('`') && !text.includes('[')) {
    return [{ type: 'text', text: { content: text } }];
  }

  const pattern = new RegExp(INLINE_MD_RE.source, 'g')
  const result = []
  let lastIndex = 0
  let match

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index)
      if (plain) result.push({ type: 'text', text: { content: plain } })
    }
    if (match[1] !== undefined) {
      result.push({ type: 'text', text: { content: match[2] }, annotations: { bold: true } })
    } else if (match[3] !== undefined) {
      result.push({ type: 'text', text: { content: match[4] }, annotations: { code: true } })
    } else if (match[5] !== undefined) {
      result.push({ type: 'text', text: { content: match[6], link: { url: match[7] } } })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    result.push({ type: 'text', text: { content: text.slice(lastIndex) } })
  }
  return result.length > 0 ? result : [{ type: 'text', text: { content: text } }]
}

// 辅助：收集连续匹配的行
function collectLines(start, lines, predicate) {
  const parts = []
  let j = start
  while (j < lines.length && predicate(lines[j])) { parts.push(lines[j]); j++ }
  return { lines: parts, end: j }
}

// 预编译正则（避免每次调用重新编译）
const TABLE_SEP_RE = /^\|[\s\-:|]+\|$/;
const BULLET_RE = /^[-*]\s/;
const NUM_LIST_RE = /^\d+\.\s/;
const HEADING_RE = /^(#+)\s/;

function mdToBlocks(markdown) {
  const rawLines = markdown.split('\n')
  const lines = rawLines.map(l => l.trim()) // 预 trim
  const blocks = []
  let i = 0

  function isTableRow(l) { return l.startsWith('|') && l.endsWith('|') }
  function isTableSep(l) { return TABLE_SEP_RE.test(l) }
  function isQuote(l) { return l.startsWith('> ') }

  function parseTableCells(rowLine) {
    return rowLine
      .replace(/^\|/, '').replace(/\|$/, '')
      .split('|')
      .map(cell => parseInlineMarkdown(cell.trim()))
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line === '') { i++; continue }

    // 标题 —— 通用 # 匹配，h4+ 降级为 h3（Notion 只支持 h1/h2/h3）
    if (line.startsWith('#')) {
      const m = line.match(HEADING_RE)
      if (m) {
        const depth = Math.min(m[1].length, 3)
        const text = line.slice(m[1].length + 1)
        const type = {1:'heading_1',2:'heading_2',3:'heading_3'}[depth]
        blocks.push({ type, [type]: { rich_text: parseInlineMarkdown(text) } })
        i++; continue
      }
    }

    // 分隔线
    if (line === '---' || line === '***') {
      blocks.push({ type: 'divider', divider: {} })
      i++; continue
    }

    // 代码块（保留原始缩进）
    if (line.startsWith('```')) {
      const codeParts = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { codeParts.push(rawLines[i]); i++ }
      i++
      blocks.push({ type: 'code', code: { rich_text: [{ type: 'text', text: { content: codeParts.join('\n') } }], language: 'plain text' } })
      continue
    }

    // 表格
    if (isTableRow(line)) {
      const tableRows = []
      while (i < lines.length && isTableRow(lines[i])) {
        const t = lines[i]
        if (!isTableSep(t)) tableRows.push(t)
        i++
      }
      if (tableRows.length === 0) continue
      const headerCells = parseTableCells(tableRows[0])
      const colCount = headerCells.length
      const tableChildren = []
      tableChildren.push({ type: 'table_row', table_row: { cells: headerCells } })
      for (let r = 1; r < tableRows.length; r++) {
        const cells = parseTableCells(tableRows[r])
        while (cells.length < colCount) cells.push([{ type: 'text', text: { content: '' } }])
        tableChildren.push({ type: 'table_row', table_row: { cells } })
      }
      blocks.push({ type: 'table', table: { table_width: colCount, has_column_header: true, has_row_header: false, children: tableChildren } })
      continue
    }

    // 多行引用
    if (isQuote(line)) {
      const { lines: quoteLines, end } = collectLines(i, lines, l => isQuote(l))
      blocks.push({ type: 'quote', quote: { rich_text: parseInlineMarkdown(quoteLines.map(l => l.slice(2)).join('\n')) } })
      i = end; continue
    }

    // 无序列表
    if (BULLET_RE.test(line)) {
      blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInlineMarkdown(line.replace(BULLET_RE, '')) } })
      i++; continue
    }

    // 有序列表
    if (NUM_LIST_RE.test(line)) {
      blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: parseInlineMarkdown(line.replace(NUM_LIST_RE, '')) } })
      i++; continue
    }

    // 普通段落
    const { lines: paraLines, end } = collectLines(i, lines,
      l => l !== '' && !isTableRow(l) && !isQuote(l) && !l.startsWith('```') && !l.startsWith('#') && !BULLET_RE.test(l) && !NUM_LIST_RE.test(l))
    const paraText = paraLines.join('\n')
    if (paraText.trim()) {
      blocks.push({ type: 'paragraph', paragraph: { rich_text: parseInlineMarkdown(paraText) } })
    }
    i = end
  }

  return blocks
}

// ============ 同步 Markdown 文件到 Notion 页面 ============

// 清空页面上所有已有 children blocks
async function clearAllChildren(pageId) {
  let totalDeleted = 0
  let hasMore = true

  while (hasMore) {
    const resp = await notionRequest('GET', `/blocks/${pageId}/children?page_size=100`)
    const children = resp.results || []
    if (children.length === 0) break
    hasMore = resp.has_more || false

    console.log(`🧹 清空现有 ${children.length} 个 blocks...`)

    // 逐条删除（不批量并行），单条失败不影响后续
    for (let i = 0; i < children.length; i++) {
      const block = children[i]
      try {
        await notionRequest('DELETE', `/blocks/${block.id}`)
        totalDeleted++
      } catch (err) {
        console.log(`   ⚠️  跳过 block ${block.type} (${block.id.substring(0, 8)}...): ${err.message.substring(0, 80)}`)
      }
      // 每 10 个稍作停顿
      if ((i + 1) % 10 === 0) {
        console.log(`   🗑️  已处理 ${i + 1}/${children.length}`)
        await new Promise(r => setTimeout(r, 200))
      }
    }
    console.log(`   ✅ 本轮完成，累计删除 ${totalDeleted} blocks`)
  }
  return totalDeleted
}

async function syncFile(filePath, pageIdOverride, forceNew = false, replace = false) {
  const targetPageId = pageIdOverride || process.env.NOTION_SYNC_PAGE_ID || SYNC_PAGE_ID

  if (!targetPageId) {
    console.error('❌ 未设置目标页面 ID。请通过以下方式之一提供：')
    console.error('   1. 命令行: --page-id "your_page_id"')
    console.error('   2. 环境变量: export NOTION_SYNC_PAGE_ID="your_page_id"')
    console.error('   3. 脚本顶部修改 SYNC_PAGE_ID 常量')
    console.error('')
    console.error('   获取页面 ID: 打开 Notion 页面 → 复制 URL → 最后一段 32 位字符')
    process.exit(1)
  }

  const absPath = path.resolve(filePath)
  if (!fs.existsSync(absPath)) {
    console.error(`❌ 文件不存在: ${absPath}`)
    process.exit(1)
  }

  const fileName = path.basename(absPath, '.md')
  const md = fs.readFileSync(absPath, 'utf-8')
  const blocks = mdToBlocks(md)

  if (blocks.length === 0) {
    console.error('❌ 没有可同步的内容')
    process.exit(1)
  }

  console.log(`📄 读取文件: ${path.basename(absPath)} (${blocks.length} blocks)`)

  // 格式化 UUID
  function formatUUID(id) {
    const hex = id.replace(/[^0-9a-fA-F]/g, '')
    if (hex.length !== 32) return id
    return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
  }

  // 直接用传入的页面 ID 作为目标，内容写在该页面上（不创建子页面）
  const pageId = formatUUID(targetPageId)

  // --replace 模式：先取消归档 → 清空页面再写入
  if (replace) {
    console.log(`🔄 替换模式：准备页面 ${pageId.substring(0, 8)}...`)
    // 确保页面未归档
    await notionRequest('PATCH', `/pages/${pageId}`, { archived: false })
    console.log(`   ✅ 页面已解除归档`)
    await clearAllChildren(pageId)
  } else {
    // 判断是否需要加分隔线：缓存中记录了该文件已同步过 → 加分隔线
    const cache = loadPageCache()
    const hasSynced = !forceNew && cache[fileName] && cache[fileName] === pageId

    if (hasSynced) {
      console.log(`📝 追加到页面: ${pageId.substring(0, 8)}...`)
      await notionRequest('PATCH', `/blocks/${pageId}/children`, {
        children: [{ type: 'divider', divider: {} }],
      })
    } else {
      console.log(`📝 首次同步到页面: ${pageId.substring(0, 8)}...`)
    }
  }

  console.log(`📤 写入 ${blocks.length} blocks...`)

  // 分批追加所有 blocks
  const BATCH_SIZE = 100
  for (let j = 0; j < blocks.length; j += BATCH_SIZE) {
    const batch = blocks.slice(j, j + BATCH_SIZE)
    const batchNum = Math.floor(j / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(blocks.length / BATCH_SIZE)
    await notionRequest('PATCH', `/blocks/${pageId}/children`, {
      children: batch,
    })
    console.log(`   ✅ batch ${batchNum}/${totalBatches} 写入成功`)
  }

  // 缓存
  const cache = loadPageCache()
  cache[fileName] = pageId
  savePageCache(cache)

  console.log(`🎉 同步完成! (${blocks.length} blocks)`)
  return { id: pageId }
}

// ============ CLI ============

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title' || args[i] === '-t') {
      opts.title = args[++i]
    } else if (args[i] === '--summary' || args[i] === '-s') {
      opts.summary = args[++i]
    } else if (args[i] === '--tags') {
      opts.tags = args[++i] ? args[i].split(',').map((s) => s.trim()) : []
    } else if (args[i] === '--status') {
      opts.status = args[++i]
    } else if (args[i] === '--date') {
      opts.date = args[++i]
    } else if (args[i] === '--list' || args[i] === '-l') {
      opts.list = true
    } else if (args[i] === '--sync-file' || args[i] === '-f') {
      opts.syncFile = args[++i]
    } else if (args[i] === '--page-id' || args[i] === '-p') {
      opts.pageId = args[++i]
    } else if (args[i] === '--diagnose' || args[i] === '-d') {
      opts.diagnose = true
    } else if (args[i] === '--force-new') {
      opts.forceNew = true
    } else if (args[i] === '--replace') {
      opts.replace = true
    } else if (args[i] === '--help' || args[i] === '-h') {
      opts.help = true
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs()

  if (opts.help || (!opts.title && !opts.list && !opts.diagnose && !opts.syncFile)) {
    console.log(`
🔧 灵溪识险 — Notion 开发日志同步

用法:
  node scripts/notion-sync.js [选项]

单条日志模式:
  --title,  -t    日志标题
  --summary, -s   日志摘要
  --tags          标签，逗号分隔，如 "bug,案例匹配"
  --status        状态
  --date          日期，YYYY-MM-DD 格式，默认今天

文件同步模式:
  --sync-file, -f <path>  同步 Markdown 文件内容到目标页面（追加到页面正文，不创建子页面）
  --page-id,  -p <id>     目标页面 ID（内容直接写在这个页面上）
  --force-new             清除同步记录重新开始（不加分隔线，当作首次同步）
  --replace               清空页面已有内容后重写（完全替换模式）

其他:
  --diagnose, -d  查看数据库属性（列名 + 类型）
  --list,  -l     列出最近 5 条日志
  --help,  -h     显示帮助

示例:
  node scripts/notion-sync.js -d
  node scripts/notion-sync.js -t "修复案例匹配误判" -s "..." --tags "bug,案例匹配" --status "已完成"
  node scripts/notion-sync.js --list
  node scripts/notion-sync.js -f 开发日志.md -p "1a2b3c4d5e6f7g8h"
`)
    process.exit(opts.help ? 0 : 1)
  }

  if (opts.diagnose) {
    await diagnose()
    return
  }

  if (opts.list) {
    await listRecent()
    return
  }

  // 文件同步模式
  if (opts.syncFile) {
    try {
      await syncFile(opts.syncFile, opts.pageId, opts.forceNew, opts.replace)
    } catch (err) {
      console.error('❌ 同步失败:', err.message)
      process.exit(1)
    }
    return
  }

  if (!opts.title) {
    console.error('❌ 缺少 --title 参数')
    process.exit(1)
  }

  try {
    await syncLog({
      title: opts.title,
      summary: opts.summary || '',
      tags: opts.tags || [],
      status: opts.status || '进行中',
      date: opts.date || undefined,
    })
  } catch (err) {
    console.error('❌ 同步失败:', err.message)
    process.exit(1)
  }
}

main()
