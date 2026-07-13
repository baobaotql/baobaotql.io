#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync(path.join(__dirname, '..', '.notion-token'), 'utf-8').trim();
const DATABASE_ID = '3963182e8c6780bca18ff13b187023c6';
const SOURCE_FILE = path.join(__dirname, '..', '开发日志-整理版.md');

function req(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://api.notion.com/v1' + endpoint);
    const d = body ? JSON.stringify(body) : undefined;
    const r = https.request({method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json', 'Notion-Version':'2022-06-28'}, timeout: 30000},
      res => { let b = ''; res.on('data', c => b+=c); res.on('end', () => { if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0,200)}`)); try { resolve(JSON.parse(b)) } catch(e) { reject(new Error(b.slice(0,200) + ' (status:' + res.statusCode + ')')) } }); });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时 (30s)')) });
    if(d) { r.setHeader('Content-Length', Buffer.byteLength(d)); r.write(d); }
    r.end();
  });
}

// ========== 行内 Markdown 解析 → Notion rich_text 数组 ==========

// 预编译正则（避免每次调用重新编译）
const INLINE_MD_RE = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;

function parseInlineMarkdown(text) {
  // 快速路径：不含任何 markdown 语法则直接返回
  if (!text.includes('**') && !text.includes('`') && !text.includes('[')) {
    return [{ type: 'text', text: { content: text } }];
  }

  const result = [];
  let lastIndex = 0;
  let match;
  const pattern = new RegExp(INLINE_MD_RE.source, 'g'); // 每次调用创建新实例重置 lastIndex

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) result.push({ type: 'text', text: { content: plain } });
    }

    if (match[1] !== undefined) {
      result.push({ type: 'text', text: { content: match[2] }, annotations: { bold: true } });
    } else if (match[3] !== undefined) {
      result.push({ type: 'text', text: { content: match[4] }, annotations: { code: true } });
    } else if (match[5] !== undefined) {
      result.push({ type: 'text', text: { content: match[6], link: { url: match[7] } } });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ type: 'text', text: { content: text.slice(lastIndex) } });
  }

  return result.length > 0 ? result : [{ type: 'text', text: { content: text } }];
}

// ========== 辅助：合并连续段落多行文本 ==========

function collectLines(start, lines, predicate) {
  const parts = [];
  let j = start;
  while (j < lines.length && predicate(lines[j])) {
    parts.push(lines[j]);
    j++;
  }
  return { lines: parts, end: j };
}

// ========== Markdown → Notion Blocks（完整版）==========

function mdToBlocks(md) {
  const rawLines = md.split('\n');
  const lines = rawLines.map(l => l.trim()); // 预 trim，避免后面反复 trim
  const blocks = [];
  let i = 0;

  // 预编译正则
  const tableSepRe = /^\|[\s\-:|]+\|$/;
  const bulletRe = /^[-*]\s/;
  const numListRe = /^\d+\.\s/;

  function isTableRow(l) { return l.startsWith('|') && l.endsWith('|'); }
  function isTableSep(l) { return tableSepRe.test(l); }
  function isQuote(l) { return l.startsWith('> '); }

  // 解析表格单元格内容 → rich_text 二维数组
  function parseTableCells(rowLine) {
    return rowLine
      .replace(/^\|/, '').replace(/\|$/, '')
      .split('|')
      .map(cell => parseInlineMarkdown(cell.trim()));
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line === '') { i++; continue; }

    // --- 标题 ---
    // 通用 # 标题处理：h4+ 降级为 h3（Notion 只支持 h1/h2/h3）
    if (line.startsWith('#')) {
      const level = line.match(/^(#+)\s/);
      if (level) {
        const depth = Math.min(level[1].length, 3);
        const text = line.slice(level[1].length + 1);
        const type = {1:'heading_1',2:'heading_2',3:'heading_3'}[depth];
        blocks.push({ type, [type]: { rich_text: parseInlineMarkdown(text) } });
        i++;
        continue;
      }
    }

    // --- 分隔线 ---
    if (line === '---' || line === '***') {
      blocks.push({ type: 'divider', divider: {} });
      i++;
      continue;
    }

    // --- 代码块 ---
    if (line.startsWith('```')) {
      const codeParts = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeParts.push(rawLines[i]); // 保留原始缩进
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: codeParts.join('\n') } }],
          language: 'plain text',
        },
      });
      continue;
    }

    // --- 表格（收集所有连续表格行） ---
    if (isTableRow(line)) {
      const tableRows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        const t = lines[i];
        if (!isTableSep(t)) tableRows.push(t);
        i++;
      }
      if (tableRows.length === 0) continue;

      // 第一行是表头
      const headerCells = parseTableCells(tableRows[0]);
      const colCount = headerCells.length;

      // 构建 Notion table 子 block 数组
      const tableChildren = [];

      // 表头行
      tableChildren.push({
        type: 'table_row',
        table_row: { cells: headerCells },
      });

      // 数据行
      for (let r = 1; r < tableRows.length; r++) {
        const cells = parseTableCells(tableRows[r]);
        // 补齐列数
        while (cells.length < colCount) cells.push([{ type: 'text', text: { content: '' } }]);
        tableChildren.push({
          type: 'table_row',
          table_row: { cells },
        });
      }

      blocks.push({
        type: 'table',
        table: {
          table_width: colCount,
          has_column_header: true,
          has_row_header: false,
          children: tableChildren,
        },
      });
      continue;
    }

    // --- 引用（合并连续 > 行） ---
    if (isQuote(line)) {
      const { lines: quoteLines, end } = collectLines(i, lines, l => isQuote(l));
      const quoteText = quoteLines.map(l => l.slice(2)).join('\n');
      blocks.push({
        type: 'quote',
        quote: { rich_text: parseInlineMarkdown(quoteText) },
      });
      i = end;
      continue;
    }

    // --- 无序列表 ---
    if (bulletRe.test(line)) {
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseInlineMarkdown(line.replace(bulletRe, '')) },
      });
      i++;
      continue;
    }

    // --- 有序列表 ---
    if (numListRe.test(line)) {
      blocks.push({
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: parseInlineMarkdown(line.replace(numListRe, '')) },
      });
      i++;
      continue;
    }

    // --- 普通段落（收集到下一个空行或匹配块元素标记的行） ---
    const { lines: paraLines, end } = collectLines(i, lines,
      l => l !== '' && !l.startsWith('|') && !isQuote(l) && !l.startsWith('```') && !l.startsWith('#') && !bulletRe.test(l) && !numListRe.test(l)
    );
    const paraText = paraLines.join('\n');
    if (paraText.trim()) {
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: parseInlineMarkdown(paraText) },
      });
    }
    i = end;
  }

  return blocks;
}

// ========== 主流程 ==========

async function main() {
  console.log('🚀 开始...\n');

  // 1. 读取 + 解析
  const md = fs.readFileSync(SOURCE_FILE, 'utf-8');
  const blocks = mdToBlocks(md);
  console.log(`📄 解析完成: ${blocks.length} blocks`);

  const stats = {};
  for (const b of blocks) stats[b.type] = (stats[b.type] || 0) + 1;
  console.log('   类型分布:', JSON.stringify(stats));

  // 2. 在数据库中创建新页面（无删除，秒级完成）
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n📝 创建子页面...`);
  const newPage = await req('POST', '/pages', {
    parent: { database_id: DATABASE_ID },
    properties: {
      标题: { title: [{ type: 'text', text: { content: `开发日志整理版 - ${today}` } }] },
      日期: { date: { start: today } },
      状态: { select: { name: '已完成' } },
      多选: { multi_select: [{ name: '功能' }] },
    },
  });
  const newPageId = newPage.id;
  const pageUrl = `https://notion.so/${newPageId.replace(/-/g, '')}`;
  console.log(`   ✅ 已创建: ${pageUrl}`);

  // 3. 分批写入 blocks
  console.log(`\n📤 写入 ${blocks.length} blocks...`);
  const BATCH_SIZE = 100;
  const totalBatches = Math.ceil(blocks.length / BATCH_SIZE);
  for (let j = 0; j < blocks.length; j += BATCH_SIZE) {
    const batch = blocks.slice(j, j + BATCH_SIZE);
    const n = Math.floor(j / BATCH_SIZE) + 1;
    await req('PATCH', `/blocks/${newPageId}/children`, { children: batch });
    console.log(`   batch ${n}/${totalBatches} ✓`);
  }

  console.log(`\n🎉 完成! ${blocks.length} blocks，请手动复制粘贴到父页面`);
  console.log(`   ${pageUrl}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
