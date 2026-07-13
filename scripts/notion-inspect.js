#!/usr/bin/env node

/**
 * 从父页面读取所有子页面的 blocks 内容（用于后续整合）
 */

const https = require('https')
const fs = require('fs')
const path = require('path')

const TOKEN_FILE = path.join(__dirname, '..', '.notion-token')
const PARENT_PAGE_ID = '3963182e8c678028be39e30fb000f4f2'

function loadToken() {
  return fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
}

function notionRequest(method, endpoint, body) {
  const token = loadToken()
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.notion.com/v1${endpoint}`)
    const data = body ? JSON.stringify(body) : undefined
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
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
          const json = JSON.parse(body)
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json)
          else reject(new Error(`API ${res.statusCode}: ${json.message || body}`))
        } catch (e) {
          reject(new Error(`JSON parse fail (${res.statusCode})`))
        }
      })
    })
    req.on('error', reject)
    if (data) { req.setHeader('Content-Length', Buffer.byteLength(data)); req.write(data) }
    req.end()
  })
}

function formatUUID(id) {
  const hex = id.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) return id
  return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}

function blockToText(block) {
  const type = block.type
  if (!block[type]) return ''
  const rt = block[type].rich_text || block[type].text || block[type].title || []
  return rt.map(t => t.plain_text || t.text?.content || '').join('')
}

async function getPageBlocks(pageId, cursor) {
  const params = cursor ? `?start_cursor=${cursor}` : ''
  return notionRequest('GET', `/blocks/${formatUUID(pageId)}/children${params}`)
}

async function getAllBlocks(pageId) {
  let allBlocks = []
  let cursor = undefined
  do {
    const resp = await getPageBlocks(pageId, cursor)
    allBlocks = allBlocks.concat(resp.results)
    cursor = resp.has_more ? resp.next_cursor : null
  } while (cursor)
  return allBlocks
}

async function main() {
  // 1. 获取父页面下所有子页面
  console.log('🔍 获取父页面子页面列表...\n')
  const children = await getPageBlocks(PARENT_PAGE_ID, undefined)

  const childPages = []
  for (const block of children) {
    if (block.type === 'child_page') {
      const title = block.child_page?.title || ''
      childPages.push({ id: block.id, title })
      console.log(`   📄 "${title}" → ${block.id}`)
    }
  }

  if (childPages.length === 0) {
    console.log('   无子页面')
  }

  // 2. 也搜索 workspace 中的页面
  console.log('\n🔍 搜索 workspace 中的相关页面...\n')
  const searchResult = await notionRequest('POST', '/search', {
    query: 'Silver-Finance',
    filter: { property: 'object', value: 'page' },
    page_size: 20,
  })

  for (const page of searchResult.results) {
    const title = page.properties?.title?.title?.[0]?.plain_text || 
                  page.properties?.['标题']?.title?.[0]?.plain_text ||
                  '(无标题)'
    const isArchived = page.archived ? ' (已归档)' : ''
    const isDB = page.parent?.type === 'database_id' ? ' [数据库]' : ' [页面]'
    console.log(`   📄 "${title}"${isDB}${isArchived} → ${page.id}`)
  }

  // 输出所有页面 ID 供后续读取
  console.log('\n---')
  console.log(JSON.stringify({ childPages, searchResults: searchResult.results.map(p => ({ id: p.id, archived: p.archived, parentType: p.parent?.type })) }, null, 2))
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })
