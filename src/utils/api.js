/**
 * 后端 API 模块 — 智谱 GLM-4.6V 多模态大模型
 *
 * 使用 GLM-4.6V 视觉模型，直接识别图片内容并分析金融风险。
 * 案例匹配已升级为 LLM 语义匹配（取代旧的关键词匹配）。
 *
 * 智谱 API 文档: https://docs.bigmodel.cn/api-reference/模型-api/对话补全
 */

import {
  RISK_LEVEL,
  HIGH_RISK_KEYWORDS,
  CAUTION_KEYWORDS,
  SAFETY_KEYWORDS,
  CAUTION_ESCALATION_THRESHOLD,
  OCR_MAX_LENGTH,
  OUTPUT_LIMITS,
  BANNED_SAFETY_PHRASES,
  LOW_RISK_SAFE_PHRASES,
} from './constants'
import { mockOcrText, mockAnalyze } from './mock'
import { getCachedResult, setCachedResult } from './storage'
import {
  // recallTopCandidates / formatCandidatesForPrompt 预留给未来 >50 案例时的 N-gram 粗筛模式
  CASES,
  formatAllCasesForPrompt,
  getCaseById,
} from './caseLibrary'

// ==================== 配置 ====================

const ZHIPU_API_KEY = '70be54e0e544425d85efae48970a41ec.4Z2k7Adwhzpo0Ive'
const ZHIPU_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const ZHIPU_MODEL = 'glm-4.6v'
const USE_MOCK = false
const REQUEST_TIMEOUT = 90000
const MAX_IMAGE_SIZE = 1024

// ==================== 系统提示词（含案例匹配指令） ====================

function buildSystemPrompt() {
  const caseCount = CASES.length
  const useFullLibrary = caseCount <= 50
  let caseSection = ''

  if (useFullLibrary) {
    // 案例少：全量塞入 prompt
    const allCases = formatAllCasesForPrompt()
    caseSection = `\n【参考案例库（共 ${caseCount} 条真实诈骗案例）】\n${allCases}`
  }
  // >50 条时不预填，运行时用 N-gram 候选动态注入

  return `你是金融反诈分析助手。用户发送图片，请完成以下所有8项任务（每项都必须输出）：
1. 提取图中所有文字(ocrText)
2. 标注风险关键词(ocrSegments, highlight=true)
3. 判断风险等级(riskLevel: low/caution/high)
4. 给出风险类型(riskType, ≤15字)
5. 风险原因(riskReason, ≤80字)
6. 老人版大白话解释(plainExplanation, ≤120字, 用70岁以上老人能懂的语言)
7.【必须】案例语义匹配(caseMatch): 判断图片内容是否与参考案例库中某条案例属于同一诈骗套路。即使不匹配也必须输出 {"caseId":"","match":false,"reason":"无匹配案例"}。注意！反诈宣传/防骗提醒/安全公告 → match=false
8. 防骗建议(suggestions, 3条, 每条≤50字)

严格JSON返回(不含markdown标记，caseMatch必须在suggestions前面):
{"ocrText":"","ocrSegments":[{"text":"","highlight":false}],"riskLevel":"low","riskType":"","riskReason":"","plainExplanation":"","caseMatch":{"caseId":"","match":false,"reason":""},"suggestions":["","",""]}

caseMatch格式（必须原样出现在JSON中）:
- match=true时: {"caseId":"案例ID","match":true,"reason":"匹配理由≤20字"}
- match=false时: {"caseId":"","match":false,"reason":"无匹配案例"}

风险等级判定标准（阈值要低，宁可误判为高也不要漏判）:
【high高风险】命中以下任意一条即判高风险（优先判高风险）:
- 索要验证码、密码、银行卡号、身份证号等敏感信息
- 要求转账/汇款/扫码付款/充值到指定账户
- 冒充公检法/银行/客服/政府机构（出现公安局、检察院、法院、通信管理局等）
- 声称涉嫌犯罪/通缉/逮捕/冻结账户/资金清查
- 含恶意链接/要求下载不明APP/要求屏幕共享
- 兼职刷单/日赚/荐股带单/内幕消息/稳赚不赔
- 无抵押贷款/征信修复/黑户可贷
- 中奖需手续费/发展下线/拉人头
- 针对老人：特效药/祖传秘方/保健品诈骗/代办养老金/子女出事紧急转账
- 使用威胁性语言：否则后果自负/最后机会/立即停用/已被锁定

【caution需谨慎】以下情况判需谨慎:
- 承诺高收益/保本理财但不直接索要资金
- 限时限量/内部名额但无转账指令
- 免费领取/红包诱导但未索要敏感信息
- 中奖通知/退款理赔但未索要手续费
- 投资推荐但非明确杀猪盘套路

【low低风险】仅常规信息/无诱导/无敏感词时判低风险:
- riskType必须写"暂未发现明显风险特征"
- 不准使用"内容安全""可以放心""无风险""完全可信"等绝对描述
- 反诈宣传/防骗提醒/警方安全公告 → 判低风险，caseMatch.match=false

【案例语义匹配规则】caseMatch:
- match为true时: caseId填匹配案例的id, reason简短说明匹配理由（≤30字）
- match为false时: caseId为空字符串, reason写"无匹配案例"或简要说明原因
- 以下情况必须match=false:
  ① 图片内容是反诈宣传/防骗提醒/安全公告（即使关键词与案例重叠）
  ② 图片内容与案例库中所有案例套路均不同
  ③ 图片不涉及诈骗行为${caseSection}`
}

// ==================== 工具函数 ====================

function apiRequest(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    console.log('[API] 发起请求:', url)
    const bodySize = JSON.stringify(data).length
    console.log('[API] 数据大小:', bodySize, '字节')

    uni.request({
      url,
      method: 'POST',
      header: { 'Content-Type': 'application/json', ...headers },
      data,
      timeout: REQUEST_TIMEOUT,
      success: (res) => {
        console.log('[API] 响应状态码:', res.statusCode)
        if (res.statusCode === 200 && res.data) {
          resolve(res.data)
        } else {
          const errMsg = res.data?.error?.message || `请求失败(${res.statusCode})`
          console.error('[API] 请求失败:', errMsg)
          reject(new Error(errMsg))
        }
      },
      fail: (err) => {
        console.error('[API] 网络请求:', err.errMsg)
        reject(new Error(err.errMsg || '网络请求失败'))
      },
    })
  })
}

async function imageToBase64(filePath) {
  let compressedPath = filePath
  try {
    const compressRes = await new Promise((resolve, reject) => {
      uni.compressImage({
        src: filePath,
        quality: 60,
        compressedWidth: MAX_IMAGE_SIZE,
        success: resolve,
        fail: reject,
      })
    })
    compressedPath = compressRes.tempFilePath
    console.log('[API] 图片压缩成功')
  } catch (e) {
    console.warn('[API] 压缩跳过，使用原图')
  }

  return new Promise((resolve, reject) => {
    uni.getFileSystemManager().readFile({
      filePath: compressedPath,
      encoding: 'base64',
      success: (res) => {
        if (res.data) {
          console.log('[API] Base64 长度:', res.data.length)
          resolve(res.data)
        } else {
          reject(new Error('Base64 数据为空'))
        }
      },
      fail: (err) => reject(new Error('图片读取失败: ' + (err.errMsg || ''))),
    })
  })
}

function getImageMimeType(filePath) {
  const lower = (filePath || '').toLowerCase()
  if (lower.includes('.png')) return 'image/png'
  if (lower.includes('.gif')) return 'image/gif'
  if (lower.includes('.webp')) return 'image/webp'
  return 'image/jpeg'
}

/**
 * 图片指纹：取 base64 首部 + 中部 + 尾部拼接
 * 避免仅取头部导致 JPEG/PNG 文件头碰撞
 */
function simpleHash(base64) {
  if (!base64 || base64.length === 0) return ''
  const len = base64.length
  const head = base64.substring(0, 256)
  const mid = base64.substring(Math.floor(len / 2), Math.floor(len / 2) + 256)
  const tail = base64.substring(Math.max(0, len - 256))
  const combined = head + '|' + mid + '|' + tail
  let hash = 0
  for (let i = 0; i < combined.length; i++) {
    const c = combined.charCodeAt(i)
    hash = ((hash << 5) - hash + c) | 0
  }
  return 'img_' + (hash >>> 0).toString(36)
}

// ==================== 关键词扫描引擎（含反诈宣教校验） ====================

/**
 * 扫描 OCR 文本中的风险关键词 + 反诈宣教特征
 *
 * 关键改进：如果同时命中反诈宣教特征词（≥2个），
 * 说明很可能是反诈宣传内容而非真实诈骗，
 * 此时即使命中了风险关键词也不判高风险。
 *
 * 仅用于 API 失败的兜底路径。
 */
function scanRiskKeywords(text) {
  const lower = (typeof text === 'string' ? text : String(text || '')).toLowerCase()
  const highHits = HIGH_RISK_KEYWORDS.filter((kw) => lower.includes(kw))
  const cautionHits = CAUTION_KEYWORDS.filter((kw) => lower.includes(kw))
  const safetyHits = SAFETY_KEYWORDS.filter((kw) => lower.includes(kw))

  let level = RISK_LEVEL.LOW

  if (safetyHits.length >= 2) {
    // 反诈宣教特征明显 → 即使有风险关键词也不判高风险
    level = RISK_LEVEL.LOW
    console.log('[扫描] 检测到反诈宣教特征(', safetyHits.length, '个), 忽略风险关键词匹配. 命中:', safetyHits.slice(0, 5).join(', '))
  } else if (highHits.length > 0) {
    level = RISK_LEVEL.HIGH
  } else if (cautionHits.length >= CAUTION_ESCALATION_THRESHOLD) {
    level = RISK_LEVEL.HIGH
    console.log('[扫描] 组合升级：', cautionHits.length, '条需谨慎关键词 → 高风险')
  } else if (cautionHits.length > 0) {
    level = RISK_LEVEL.CAUTION
  }

  return { level, highHits, cautionHits, safetyHits, hasAny: highHits.length + cautionHits.length > 0 }
}

// ==================== OCR 文本截断 ====================

/**
 * 智能截断 OCR 文本：保留关键词附近上下文
 */
function truncateOcrText(text) {
  if (!text || typeof text !== 'string' || text.length <= OCR_MAX_LENGTH) return text

  const allKeywords = [...HIGH_RISK_KEYWORDS, ...CAUTION_KEYWORDS]
  const keywordPositions = []

  allKeywords.forEach((kw) => {
    let idx = text.indexOf(kw)
    while (idx !== -1) {
      keywordPositions.push(idx)
      idx = text.indexOf(kw, idx + 1)
    }
  })

  if (keywordPositions.length === 0) {
    return text.substring(0, Math.floor(OCR_MAX_LENGTH * 0.7)) +
      '…[内容过长已截断]…' +
      text.substring(text.length - Math.floor(OCR_MAX_LENGTH * 0.3))
  }

  keywordPositions.sort((a, b) => a - b)
  const contextRadius = Math.floor(OCR_MAX_LENGTH / 2)

  const firstPos = Math.max(0, keywordPositions[0] - contextRadius / 2)
  const lastPos = Math.min(
    text.length,
    keywordPositions[keywordPositions.length - 1] + contextRadius / 2,
  )

  let result = text.substring(firstPos, lastPos)
  if (result.length > OCR_MAX_LENGTH) {
    result = result.substring(0, OCR_MAX_LENGTH) + '…[已截断]'
  }
  if (firstPos > 0) result = '…' + result
  if (lastPos < text.length) result = result + '…'

  return result
}

// ==================== 低风险-后处理安全语言过滤 ====================

function sanitizeLowRiskResult(result) {
  if (result.riskLevel !== RISK_LEVEL.LOW) return result

  // 低风险结果统一覆盖为安全文案，避免 LLM 描述图片具体内容
  // （如"图片中是一杯奶茶""一朵花"等非金融场景），保护用户隐私感知
  result.riskType = LOW_RISK_SAFE_PHRASES.riskType
  result.riskReason = LOW_RISK_SAFE_PHRASES.riskReason
  result.plainExplanation = LOW_RISK_SAFE_PHRASES.plainExplanation

  // 建议列表同步清洗，过滤含禁用词的建议项
  if (Array.isArray(result.suggestions) && result.suggestions.length > 0) {
    result.suggestions = result.suggestions.map((s) => {
      if (!s || typeof s !== 'string') return s
      const hasBanned = BANNED_SAFETY_PHRASES.some((p) => s.includes(p))
      return hasBanned ? '请保持警惕，涉及资金操作前务必多方核实后再行动' : s
    })
  }

  return result
}

// ==================== JSON 多层解析回退引擎 ====================

function tryParseJSON(raw) {
  const strategies = [
    () => JSON.parse(raw),
    () => {
      const cleaned = raw
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim()
      return JSON.parse(cleaned)
    },
    () => {
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('no match')
      return JSON.parse(match[0])
    },
    () => {
      const start = raw.indexOf('{')
      if (start === -1) throw new Error('no brace')
      let depth = 0
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++
        else if (raw[i] === '}') {
          depth--
          if (depth === 0) return JSON.parse(raw.substring(start, i + 1))
        }
      }
      throw new Error('unbalanced')
    },
    () => {
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('no match')
      let fixed = match[0]
        .replace(/,\s*\}/g, '}')
        .replace(/,\s*\]/g, ']')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
      return JSON.parse(fixed)
    },
  ]

  for (let i = 0; i < strategies.length; i++) {
    try {
      const result = strategies[i]()
      console.log('[API] JSON解析成功, 策略:', i + 1)
      return result
    } catch (e) {
      console.log('[API] 策略', i + 1, '失败:', e.message?.substring(0, 60))
    }
  }
  return null
}

/**
 * 完全无法解析 JSON 时的安全兜底：
 * 从原始文本中尽量提取字段 + 关键词扫描（含反诈宣教校验）
 */
function fallbackFromRawText(raw) {
  const text = raw || ''
  console.log('[API] 走兜底逻辑，原始文本长度:', text.length)

  const extract = (key) => {
    const patterns = [
      new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i'),
      new RegExp(`"${key}"\\s*:\\s*'([^']*)'`, 'i'),
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m && m[1]) return m[1].trim()
    }
    return ''
  }

  const extractArray = (key) => {
    const p = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i')
    const m = text.match(p)
    if (!m || !m[1]) return []
    const items = m[1].match(/"([^"]*)"/g)
    return items ? items.map((s) => s.replace(/"/g, '').trim()).filter(Boolean) : []
  }

  const ocrText = extract('ocrText') || extract('ocr_text') || text.substring(0, 500)
  const riskLevelRaw = (extract('riskLevel') || extract('risk_level') || 'low').toLowerCase()
  const validLevel = ['high', 'caution', 'low'].includes(riskLevelRaw) ? riskLevelRaw : 'low'

  // 关键词扫描（含反诈宣教校验）
  const scan = scanRiskKeywords(ocrText)
  const finalLevel = validLevel !== 'low' ? validLevel : scan.level

  const result = {
    ocrText: truncateOcrText(ocrText),
    ocrSegments: scan.highHits.concat(scan.cautionHits).map((kw) => ({ text: kw, highlight: true })),
    riskLevel: finalLevel,
    riskType: extract('riskType') || extract('risk_type') || '暂未发现明显风险特征',
    riskReason: extract('riskReason') || extract('risk_reason') || '系统辅助分析无法完整解析结果，已结合关键词扫描给出初步判断。建议核实原始信息。',
    plainExplanation: extract('plainExplanation') || extract('plain_explanation') || '这张图片系统没能完整分析出来，但已经用关键词扫描了一遍。您自己多看看图片信息，不确定就问问家人。',
    suggestions: extractArray('suggestions').length > 0
      ? extractArray('suggestions')
      : [
          '核实信息发送方是否为官方渠道',
          '不要向陌生人透露银行卡号、密码或验证码',
          '如有疑问可拨打96110反诈热线咨询',
        ],
    analyzedAt: new Date().toISOString(),
  }

  return normalizeResult(result)
}

// ==================== 核心：调用智谱 GLM-4.6V ====================

async function callGLM4VWithRetry(imageDataUrl, userText, maxRetries = 3) {
  const systemPrompt = buildSystemPrompt()
  const payload = {
    model: ZHIPU_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: userText },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
    stream: false,
    response_format: { type: 'json_object' },
  }

  let lastRes
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    console.log(`[API] 第 ${attempt + 1}/${maxRetries} 次请求...`)

    try {
      lastRes = await apiRequest(ZHIPU_API_URL, payload, {
        Authorization: `Bearer ${ZHIPU_API_KEY}`,
      })
    } catch (err) {
      console.error(`[API] 第 ${attempt + 1} 次请求网络错误:`, err.message)
      if (attempt < maxRetries - 1) {
        const wait = (attempt + 1) * 2000
        console.log(`[API] ${wait}ms 后重试...`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw err
    }

    const finishReason = lastRes?.choices?.[0]?.finish_reason || 'unknown'
    const content = lastRes?.choices?.[0]?.message?.content
    console.log('[API] 响应 finish_reason:', finishReason, 'content长度:', content?.length || 0)

    if (!content || content.trim().length === 0) {
      console.warn(`[API] 第 ${attempt + 1} 次返回为空, finish_reason:`, finishReason)
      if (finishReason === 'length') {
        console.log('[API] 检测到 length 截断，扩容重试')
        payload.max_tokens = Math.min(payload.max_tokens * 2, 4096)
      }
      if (attempt < maxRetries - 1) {
        const wait = (attempt + 1) * 2000
        console.log(`[API] ${wait}ms 后重试...`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
    }

    if (content && content.trim().length > 0) {
      console.log('[API] 模型原始返回(前300字):', content.substring(0, 300))
      console.log('[API] 模型原始返回(尾部500字):', content.substring(Math.max(0, content.length - 500)))

      const parsed = tryParseJSON(content)
      if (parsed) {
        const result = normalizeResult(parsed)
        // 🔧 兜底: 如果 JSON 里没有 caseMatch，尝试从原始文本中提取
        if (!result._caseMatchRaw && content) {
          const extracted = extractCaseMatchFromRaw(content)
          if (extracted) {
            console.log('[案例匹配-兜底] 从原始响应中提取到 caseMatch:', JSON.stringify(extracted))
            result._caseMatchRaw = extracted
          } else {
            console.log('[案例匹配-兜底] 原始响应中未找到 caseMatch 字段')
          }
        }
        return result
      }

      console.error('[API] JSON解析全部失败，使用兜底结果。原始内容:', content.substring(0, 300))
      return fallbackFromRawText(content)
    }
  }

  console.error('[API] 所有重试均返回空，使用完全兜底结果')
  return makeEmptyFallbackResult(imageDataUrl)
}

function makeEmptyFallbackResult(imageDataUrl) {
  const now = new Date().toISOString()
  const result = {
    ocrText: '',
    ocrSegments: [],
    riskLevel: RISK_LEVEL.LOW,
    riskType: LOW_RISK_SAFE_PHRASES.riskType,
    riskReason: '系统暂时无法完成图片分析，建议您仔细查看图片内容，自行判断信息真伪。',
    plainExplanation: '系统这会儿有点忙，图片没分析出来。您自己先看看图片里说了啥，要是有让转账、要密码、点链接的，别信！',
    suggestions: [
      '图片分析服务暂时繁忙，请稍后重试',
      '不要向陌生人透露银行卡号、密码或验证码',
      '如有疑问可拨打96110反诈热线咨询',
    ],
    analyzedAt: now,
    fromCache: false,
  }

  if (imageDataUrl && imageDataUrl.length > 200000) {
    result.plainExplanation = '系统这会儿有点忙，图片有点大没分析出来。不过大图片更可能包含详细信息，您仔细看看里面有没有让您转账、要密码或者点链接的内容。'
    result.riskReason = '图片较大，系统分析超时。建议您仔细阅读图片中的文字信息，如涉及转账、验证码、个人信息请高度警惕。'
  }

  return normalizeResult(result)
}

async function callGLM4V(imageBase64, mimeType, ocrHint) {
  const imageDataUrl = `data:${mimeType};base64,${imageBase64}`

  if (imageDataUrl.length > 300000) {
    console.warn('[API] 图片较大(dataUrl长度:', imageDataUrl.length, '), 可能影响API响应')
  }

  const userText = ocrHint
    ? `图片OCR已初步提取关键词：${ocrHint}。请结合图片完整分析金融风险。`
    : '请分析图片中的金融诈骗风险，按JSON格式返回。'

  return await callGLM4VWithRetry(imageDataUrl, userText)
}

// ==================== 案例语义匹配后处理 ====================

/**
 * 解析 LLM 返回的 caseMatch，转换为前端可用的格式
 *
 * 匹配规则（由 LLM 语义判断，非关键词）：
 * - LLM match=true → 绑定案例信息
 * - LLM match=false → 无匹配，不展示案例
 */
function processCaseMatch(rawResult) {
  const cm = rawResult._caseMatchRaw
  console.log('[案例匹配] _caseMatchRaw 原始值:', JSON.stringify(cm))

  if (!cm) {
    console.log('[案例匹配] 跳过：_caseMatchRaw 为 null/undefined')
    return null
  }
  if (!cm.match) {
    console.log('[案例匹配] LLM 判定 match=false，不展示案例. reason:', cm.reason)
    return null
  }
  if (!cm.caseId) {
    console.log('[案例匹配] LLM 判定 match=true 但 caseId 为空')
    return null
  }

  const matchedCase = getCaseById(cm.caseId)
  if (!matchedCase) {
    console.log('[案例匹配] LLM 返回未知 caseId:', cm.caseId, '| 库中可用ID:', 
      CASES.map(c => c.id).join(', '))
    return null
  }

  console.log('[案例匹配] LLM 语义匹配成功:', matchedCase.title, '| 理由:', cm.reason)
  return {
    title: matchedCase.title,
    brief: matchedCase.brief,
    category: matchedCase.category,
    matchReason: cm.reason || '',
    matchLevel: 'strong',
    matchScore: 1,
  }
}

/**
 * 兜底：关键词引擎案例匹配
 *
 * 当 LLM 未返回 caseMatch 时，用 OCR 文本的关键词命中来做案例匹配。
 * 匹配策略：对每个案例提取关键词，命中 ≥ 阈值即匹配。
 */
function keywordCaseMatch(ocrText) {
  if (!ocrText || typeof ocrText !== 'string' || ocrText.trim().length < 3) return null
  const text = ocrText.toLowerCase()

  // 案例 → 触发关键词映射（从案例 title + brief 中提取）
  const caseKeywords = {
    case_001: ['冒充公安', '洗钱', '安全账户', '保证金', '公安局', '涉嫌', '配合调查'],
    case_002: ['检察院', '通缉令', '银行卡号', '密码', '证清白', '逮捕'],
    case_003: ['客服', '会员', '扣费', '屏幕共享', '下载', 'app'],
    case_004: ['银监会', '清退', '回款', '手续费', '认证金', '银保监会'],
    case_021: ['刑事拘捕令', '资金清查', '逮捕令', '拘捕', '密码'],
    case_022: ['通信管理局', '停机', '强制停机', '发送诈骗', '验证码'],
    case_023: ['视频', '远程', '笔录', '警服', '盗刷', '密码'],
    case_005: ['荐股', '导师', '数字货币', '返利', '无法提现', '投资群', '内幕'],
    case_006: ['年化收益', '保本保息', '养老金', '跑路', '关闭'],
    case_024: ['黄金', '期货', '虚假交易', '平台', '账面盈利'],
    case_025: ['银行', '理财经理', '高息', '理财产品', '内部', '利率'],
    case_026: ['比特币', '挖矿', '云算力', '算力', '系统维护', '关闭'],
    case_007: ['特效药', '免费体检', '包治百病', '维生素片', '保健品', '诊断'],
    case_008: ['代办', '养老保险', '补缴', '渠道', '代办费', '失联'],
    case_009: ['养生', '讲座', '保健床垫', '磁疗仪', '成本不足千元', '推销'],
    case_027: ['干细胞', '慢性病', '注射', '治愈'],
    case_028: ['以房养老', '抵押', '房产', '养老金', '贷款', '卷走'],
    case_010: ['子女出事', '手术费', '车祸', '转账', '救命', '出车祸'],
    case_029: ['熟人', '换号', '借钱', '声音像'],
    case_017: ['医保卡', '停用', '社会保障', '冻结', '解冻', '填写', '身份证', '银行卡', '验证码', '24小时'],
    case_018: ['刷单', '兼职', '日赚', '佣金', '垫付'],
    case_019: ['网贷', '无抵押', '征信', '黑户', '低息', '贷款'],
    case_020: ['中奖', '领奖', '手续费', '个人所得税'],
  }

  const allCases = CASES

  let bestScore = 0
  let bestCase = null

  for (const c of allCases) {
    const keywords = caseKeywords[c.id]
    if (!keywords || keywords.length === 0) continue

    let hits = 0
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) hits++
    }

    const score = hits / keywords.length

    // 阈值：命中 ≥ 30% 的关键词即匹配
    if (score >= 0.3 && score > bestScore) {
      bestScore = score
      bestCase = c
    }
  }

  if (!bestCase) return null

  const matchedKws = caseKeywords[bestCase.id].filter(kw => text.includes(kw.toLowerCase()))
  return {
    title: bestCase.title,
    brief: bestCase.brief,
    category: bestCase.category,
    matchReason: `命中关键词: ${matchedKws.join('、')}`,
    matchLevel: 'keyword',
    matchScore: bestScore,
  }
}

/**
 * 兜底: 从原始响应文本中用正则提取 caseMatch 字段
 * 当 LLM 返回的 JSON 中没有 caseMatch 时使用（如被截断或遗漏）
 */
function extractCaseMatchFromRaw(content) {
  if (!content) return null

  // 尝试多种正则模式匹配 caseMatch
  const patterns = [
    // 标准格式: "caseMatch":{"caseId":"case_017","match":true,"reason":"医保卡恐吓"}
    /"caseMatch"\s*:\s*(\{[^}]+\})/,
    // 可能是 case_match
    /"case_match"\s*:\s*(\{[^}]+\})/,
    // 单引号
    /'caseMatch'\s*:\s*(\{[^}]+\})/,
    // caseMatch 后可能有嵌套引号
    /"caseMatch"\s*:\s*(\{[^}]*"caseId"\s*:\s*"[^"]*"[^}]*"match"\s*:\s*(?:true|false)[^}]*\})/,
  ]

  for (const pattern of patterns) {
    const match = content.match(pattern)
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1])
        // 标准化字段
        return {
          caseId: parsed.caseId || parsed.case_id || '',
          match: parsed.match === true || parsed.match === 'true',
          reason: parsed.reason || '',
        }
      } catch (e) {
        // JSON 子串解析失败，继续尝试下一种
      }
    }
  }

  return null
}

// ==================== 公开 API ====================

/**
 * 分析图片 — 入口函数
 *
 * @param {string} imagePath    小程序临时图片路径
 * @param {function} onProgress 进度回调 ({ stage })
 * @returns {Promise<Object>}   统一格式的分析结果
 */
export async function analyzeImage(imagePath, onProgress) {
  if (USE_MOCK) {
    onProgress?.({ stage: 'ocr' })
    const ocrText = mockOcrText(imagePath)
    if (!ocrText || typeof ocrText !== 'string' || ocrText.trim().length === 0) return null
    onProgress?.({ stage: 'analyzing' })
    return await mockAnalyze(ocrText)
  }

  try {
    console.log('[API] 开始分析:', imagePath)

    // Step 1: 图片转 Base64
    onProgress?.({ stage: 'ocr' })
    const mimeType = getImageMimeType(imagePath)
    const imageBase64 = await imageToBase64(imagePath)
    if (!imageBase64) throw new Error('图片读取失败')

    // Step 2: 检查缓存
    const hash = simpleHash(imageBase64)
    console.log('[API] 图片指纹:', hash, 'base64长度:', imageBase64.length)
    const cached = getCachedResult(hash)
    if (cached) {
      console.log('[API] 缓存命中，跳过API调用, hash:', hash)
      onProgress?.({ stage: 'analyzing' })
      await new Promise((r) => setTimeout(r, 600))
      return {
        ...cached,
        fromCache: true,
        _debug: cached._debug || { hasCaseMatchRaw: false, caseMatchRawJson: 'null', matchedCase: false, matchedCaseTitle: '' },
      }
    }
    console.log('[API] 未命中缓存, hash:', hash)

    // Step 3: 调用 GLM-4.6V（一次调用完成：OCR + 风险分析 + 案例语义匹配）
    onProgress?.({ stage: 'analyzing' })
    const rawResult = await callGLM4V(imageBase64, mimeType)
    if (!rawResult) throw new Error('分析失败')

    // Step 4: OCR 文本截断
    const ocrText = rawResult.ocrText || ''
    const truncated = truncateOcrText(ocrText)
    rawResult.ocrText = truncated

    // Step 5: 低风险安全过滤
    const sanitized = sanitizeLowRiskResult(rawResult)

    // Step 6: 案例语义匹配（LLM 已完成语义判断，此处仅做后处理）
    let matchedCase = processCaseMatch(rawResult)

    // 🔧 兜底匹配：仅当 LLM 未返回 caseMatch 字段时才启用关键词引擎
    // 若 LLM 已明确返回 caseMatch（即使 match=false），说明 LLM 已完成判断，不再用关键词覆盖
    if (!matchedCase && !rawResult._caseMatchRaw) {
      const fallbackMatch = keywordCaseMatch(rawResult.ocrText || '')
      if (fallbackMatch) {
        console.log('[案例匹配-关键词兜底] 自动匹配成功:', fallbackMatch.title)
        matchedCase = fallbackMatch
      }
    }

    // 🔧 诊断数据：保存到结果对象，供调试面板使用
    sanitized._debug = {
      hasCaseMatchRaw: !!rawResult._caseMatchRaw,
      caseMatchRawJson: JSON.stringify(rawResult._caseMatchRaw || null),
      matchedCase: !!matchedCase,
      matchedCaseTitle: matchedCase ? matchedCase.title : '',
      keywordFallback: !rawResult._caseMatchRaw && !!matchedCase,
    }

    if (matchedCase) {
      sanitized.matchedCase = matchedCase
      // 仅在非低风险时升级（LLM 已判低风险的不应因关键词兜底而上升）
      if (sanitized.riskLevel !== RISK_LEVEL.LOW && sanitized.riskLevel === RISK_LEVEL.CAUTION) {
        sanitized.riskLevel = RISK_LEVEL.HIGH
        console.log('[案例匹配] 语义匹配触发风险升级: caution → high')
      }
    } else if (rawResult._caseMatchRaw && rawResult._caseMatchRaw.reason) {
      console.log('[案例匹配] LLM 判定无匹配:', rawResult._caseMatchRaw.reason)
    }

    // Step 7: 缓存结果
    setCachedResult(hash, sanitized)
    console.log('[API] 缓存已存储, hash:', hash)
    return sanitized
  } catch (err) {
    console.error('[API] 分析失败:', err.message || err)
    throw err
  }
}

// ==================== 结果标准化 ====================

function normalizeResult(data) {
  // GLM 可能返回 caseMatch / case_match / casematch，统一标准化
  const rawCaseMatch = data.caseMatch || data.case_match || data.casematch || null

  // 🔧 诊断日志：LLM 返回了什么
  console.log('[诊断-normalize] data 中有 caseMatch?', !!data.caseMatch)
  console.log('[诊断-normalize] data 中有 case_match?', !!data.case_match)
  console.log('[诊断-normalize] rawCaseMatch:', JSON.stringify(rawCaseMatch))
  console.log('[诊断-normalize] data 所有顶层 key:', Object.keys(data).join(', '))

  // 防御：嵌套字段也做 snake_case 兼容
  if (rawCaseMatch) {
    rawCaseMatch.caseId = rawCaseMatch.caseId || rawCaseMatch.case_id || rawCaseMatch.caseid || ''
    rawCaseMatch.match = rawCaseMatch.match || rawCaseMatch.is_match || false
    rawCaseMatch.reason = rawCaseMatch.reason || rawCaseMatch.match_reason || ''
  }

  // 🔧 防御：强制 ocrText 为字符串，防止 LLM 返回非字符串（如数组、数字）导致 .trim() 崩溃
  const rawOcrText = data.ocrText || data.ocr_text || ''
  const safeOcrText = typeof rawOcrText === 'string' ? rawOcrText : String(rawOcrText)

  return {
    ocrText: safeOcrText,
    ocrSegments: data.ocrSegments || data.ocr_segments || [],
    riskLevel: data.riskLevel || data.risk_level || RISK_LEVEL.LOW,
    riskType: data.riskType || data.risk_type || '暂未发现明显风险特征',
    riskReason: (data.riskReason || data.risk_reason || '').substring(0, OUTPUT_LIMITS.riskReason),
    plainExplanation: (data.plainExplanation || data.plain_explanation || '').substring(
      0,
      OUTPUT_LIMITS.plainExplanation,
    ),
    suggestions: (data.suggestions || []).map((s) =>
      (s || '').substring(0, OUTPUT_LIMITS.suggestions),
    ),
    analyzedAt: new Date().toISOString(),
    // 保留标准化后的 raw caseMatch 供 processCaseMatch 使用
    _caseMatchRaw: rawCaseMatch,
  }
}

export default { analyzeImage }
