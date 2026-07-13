#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// 从 notion-rewrite.js 复制的全套解析逻辑
function parseInlineMarkdown(text) {
  const pattern = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  const result = [];
  let lastIndex = 0;
  let match;
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

function mdToBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;

  function isTableRow(l) { return l.trim().startsWith('|') && l.trim().endsWith('|'); }
  function isTableSep(l) { return /^\|[\s\-:|]+\|$/.test(l.trim()); }
  function isQuote(l) { return l.trim().startsWith('> '); }

  function parseTableCells(rowLine) {
    return rowLine.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => parseInlineMarkdown(cell.trim()));
  }

  function collectLines(start, lines, predicate) {
    const parts = [];
    let j = start;
    while (j < lines.length && predicate(lines[j])) { parts.push(lines[j]); j++; }
    return { lines: parts, end: j };
  }

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '') { i++; continue; }

    if (line.startsWith('### ')) {
      blocks.push({ type: 'heading_3', heading_3: { rich_text: parseInlineMarkdown(line.slice(4)) } });
      i++; continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'heading_2', heading_2: { rich_text: parseInlineMarkdown(line.slice(3)) } });
      i++; continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({ type: 'heading_1', heading_1: { rich_text: parseInlineMarkdown(line.slice(2)) } });
      i++; continue;
    }
    if (line === '---' || line === '***') {
      blocks.push({ type: 'divider', divider: {} });
      i++; continue;
    }
    if (line.startsWith('```')) {
      const codeParts = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { codeParts.push(lines[i]); i++; }
      i++;
      blocks.push({ type: 'code', code: { rich_text: [{ type: 'text', text: { content: codeParts.join('\n') } }], language: 'plain text' } });
      continue;
    }
    if (isTableRow(line)) {
      const tableRows = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        const t = lines[i].trim();
        if (!isTableSep(t)) tableRows.push(t);
        i++;
      }
      if (tableRows.length === 0) continue;
      const headerCells = parseTableCells(tableRows[0]);
      const colCount = headerCells.length;
      const tableChildren = [];
      tableChildren.push({ type: 'table_row', table_row: { cells: headerCells } });
      for (let r = 1; r < tableRows.length; r++) {
        const cells = parseTableCells(tableRows[r]);
        while (cells.length < colCount) cells.push([{ type: 'text', text: { content: '' } }]);
        tableChildren.push({ type: 'table_row', table_row: { cells } });
      }
      blocks.push({ type: 'table', table: { table_width: colCount, has_column_header: true, has_row_header: false, children: tableChildren } });
      continue;
    }
    if (isQuote(line)) {
      const { lines: quoteLines, end } = collectLines(i, lines, l => isQuote(l));
      blocks.push({ type: 'quote', quote: { rich_text: parseInlineMarkdown(quoteLines.map(l => l.trim().slice(2)).join('\n')) } });
      i = end; continue;
    }
    if (/^[-*] /.test(line)) {
      blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInlineMarkdown(line.replace(/^[-*] /, '')) } });
      i++; continue;
    }
    if (/^\d+\. /.test(line)) {
      blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: parseInlineMarkdown(line.replace(/^\d+\. /, '')) } });
      i++; continue;
    }
    const { lines: paraLines, end } = collectLines(i, lines,
      l => l.trim() !== '' && !isTableRow(l) && !isQuote(l) && !l.trim().startsWith('```') && !l.trim().startsWith('#') && !/^[-*] /.test(l.trim()) && !/^\d+\. /.test(l.trim()));
    const paraText = paraLines.join('\n');
    if (paraText.trim()) {
      blocks.push({ type: 'paragraph', paragraph: { rich_text: parseInlineMarkdown(paraText) } });
    }
    i = end;
  }
  return blocks;
}

// ---- 运行测试 ----
const src = fs.readFileSync(path.join(__dirname, '..', '开发日志-整理版.md'), 'utf-8');
const blocks = mdToBlocks(src);

const stats = {};
for (const b of blocks) stats[b.type] = (stats[b.type] || 0) + 1;
console.log('Total blocks:', blocks.length);
console.log('Stats:', JSON.stringify(stats, null, 2));

// 抽查标题
const samples = blocks.filter(b => b.type === 'heading_2' || b.type === 'heading_3').slice(0, 3);
console.log('\n=== 标题抽样 ===');
for (const s of samples) {
  const rt = s[s.type].rich_text;
  console.log(s.type + ': ' + JSON.stringify(rt.map(t => t.annotations ? t.text.content + '[BOLD]' : t.text.content)));
}

// 加粗段落
const paraBolds = blocks.filter(b => b.type === 'paragraph' && b.paragraph.rich_text.some(rt => rt.annotations?.bold)).slice(0, 3);
console.log('\n=== 加粗段落 (验证 bold annotations) ===');
for (const p of paraBolds) {
  const test = p.paragraph.rich_text.map(rt => {
    if (rt.annotations?.bold) return '**' + rt.text.content + '**';
    if (rt.annotations?.code) return '`' + rt.text.content + '`';
    return rt.text.content;
  }).join('');
  console.log(test.substring(0, 100));
}

// 表格统计
const tables = blocks.filter(b => b.type === 'table');
console.log('\n=== 表格: ' + tables.length + ' 个 ===');
for (const t of tables.slice(0, 2)) {
  const hdr = t.table.children[0].table_row.cells.map(c => (c[0]?.text?.content || ''));
  console.log('  ' + t.table.table_width + ' cols x ' + t.table.children.length + ' rows | header:', hdr.join(' | '));
}

console.log('\n✅ 解析验证完成！');
