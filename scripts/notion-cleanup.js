#!/usr/bin/env node

/**
 * Notion 页面清理工具 — 删除父页面下多余的 "开发日志" 页面
 * 保留缓存中记录的最新页面，其余同名页面全部归档
 */

const https = require('https')
const fs = require('fs')
const path = require('path')

const TOKEN_FILE = path.join(__dirname, '..', '.notion-token')
const PAGE_CACHE_FILE = path.join(__dirname, '..', '.notion-sync-page-id')

// 父页面 ID（开发日志页面所在的父页面）
const PARENT_PAGE_ID = '3963182e8c678028be39e30fb000f4f2'

function loadToken() {
  const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
  if (!token) throw new Error('Token 为空')
  return token
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json)
          } else {
            reject(new Error(`API ${res.statusCode}: ${json.message || body}`))
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败 (${res.statusCode})`))
        }
      })
    })
    req.on('error', reject)
    if (data) {
      req.setHeader('Content-Length', Buffer.byteLength(data))
      req.write(data)
    }
    req.end()
  })
}

function formatUUID(id) {
  const hex = id.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) return id
  return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}

async function archivePage(pageId) {
  await notionRequest('PATCH', `/pages/${formatUUID(pageId)}`, {
    archived: true,
  })
}

async function main() {
  // 读取缓存中的当前页面 ID
  let keepId = null
  try {
    const cache = JSON.parse(fs.readFileSync(PAGE_CACHE_FILE, 'utf-8'))
    keepId = cache['开发日志']
  } catch (_) {}

  console.log('🔍 正在查找父页面下的 "开发日志" 子页面...')
  console.log(`   父页面 ID: ${PARENT_PAGE_ID}`)
  console.log(`   保留页面: ${keepId ? keepId.substring(0, 8) + '...' : '(无缓存)'}\n`)

  // 获取父页面的所有 blocks（包含子页面）
  const result = await notionRequest('GET', `/blocks/${formatUUID(PARENT_PAGE_ID)}/children?page_size=100`)

  // 筛选子页面
  const childPages = result.results.filter((b) => b.type === 'child_page')
  
  // 找出标题为"开发日志"的页面
  const logPages = childPages.filter((p) => {
    const title = p.child_page?.title || ''
    return title.includes('开发日志')
  })

  if (logPages.length === 0) {
    console.log('❌ 未找到 "开发日志" 子页面')
    return
  }

  console.log(`📋 找到 ${logPages.length} 个 "开发日志" 页面:\n`)
  for (const p of logPages) {
    const id = p.id
    const isKeep = keepId && id === keepId
    console.log(`   ${isKeep ? '✅ (保留) ' : '🗑️  (删除) '} ${id} — "${p.child_page?.title || '(无标题)'}"`)
  }

  // 归档所有非保留页面
  const toArchive = logPages.filter((p) => !keepId || p.id !== keepId)

  if (toArchive.length === 0) {
    console.log('\n✅ 没有需要清理的页面')
    return
  }

  console.log(`\n⚠️  将归档 (删除) ${toArchive.length} 个多余页面...\n`)

  for (const p of toArchive) {
    try {
      await archivePage(p.id)
      console.log(`   ✅ 已归档: ${p.id}`)
    } catch (err) {
      console.error(`   ❌ 归档失败: ${p.id} — ${err.message}`)
    }
  }

  console.log(`\n🎉 清理完成! 保留了页面: ${keepId}`)
}

main().catch((err) => {
  console.error('❌ 错误:', err.message)
  process.exit(1)
})
