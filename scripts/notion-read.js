#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync(path.join(__dirname, '..', '.notion-token'), 'utf-8').trim();
const PARENT = '3963182e8c678028be39e30fb000f4f2';
const CHILD_LOG = '3963182e-8c67-81c9-9819-e72d23e556f9';

function req(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://api.notion.com/v1' + endpoint);
    const d = body ? JSON.stringify(body) : undefined;
    const r = https.request({method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json', 'Notion-Version':'2022-06-28'}},
      res => { let b = ''; res.on('data', c => b+=c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch(e) { reject(new Error(b)) } }); });
    r.on('error', reject);
    if(d) { r.setHeader('Content-Length', Buffer.byteLength(d)); r.write(d); }
    r.end();
  });
}

function blockText(b) {
  const rt = b[b.type]?.rich_text || b[b.type]?.text || b[b.type]?.title || [];
  return rt.map(t => t.plain_text || t.text?.content || '').join('');
}

async function getAllBlocks(pageId) {
  let all = [], cursor = undefined;
  do {
    const p = cursor ? '?start_cursor=' + encodeURIComponent(cursor) : '';
    const resp = await req('GET', '/blocks/' + pageId + '/children' + p);
    all = all.concat(resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return all;
}

async function main() {
  // 1. Search for Development Log
  console.log('=== SEARCH: Development Log ===\n');
  const s = await req('POST', '/search', { query: 'Development Log', page_size: 20 });
  for (const p of s.results) {
    const t = p.child_page?.title || p.properties?.title?.title?.[0]?.plain_text
      || p.properties?.['标题']?.title?.[0]?.plain_text || '(none)';
    console.log(`ID: ${p.id}  Title: "${t}"  Archived: ${p.archived}  Parent: ${p.parent?.type}`);
  }

  // 2. Read 开发日志 child page
  console.log('\n=== CONTENT: 开发日志子页面 ===\n');
  const blocks = await getAllBlocks(CHILD_LOG);
  for (const b of blocks) {
    const txt = blockText(b);
    const m = {heading_1:'# ', heading_2:'## ', heading_3:'### ', bulleted_list_item:'- ', numbered_list_item:'1. ', quote:'> ', divider:'---', to_do:'- [ ] '};
    const pfx = m[b.type] || '';
    if (b.type === 'divider') console.log('---');
    else console.log(pfx + txt);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
