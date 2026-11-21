// 写真判定（lib/vision.js）の試し。最新の結果ファイルから知らせた物件を N 件選んで判定し、結果を表示する。
// 使い方：node new-monitor/tools/test-vision.js [件数] [URLに含む文字（任意）]
// ANTHROPIC_API_KEY が要る（値は表示しない）。
'use strict';
const fs = require('fs');
const path = require('path');
const { loadKey, readEnc } = require('../lib/store');
const { checkStudio } = require('../lib/vision');

(async () => {
  const n = parseInt(process.argv[2] || '5', 10);
  const filter = process.argv[3] || '';
  const dir = path.join(__dirname, '..', 'results');
  const key = loadKey();
  const files = fs.readdirSync(dir).sort().reverse();
  const seen = new Set();
  const list = [];
  for (const f of files) {
    for (const run of readEnc(path.join(dir, f), key).runs) {
      for (const ev of run.events) {
        const x = ev.listing;
        if (!x || !(x.images || []).length || seen.has(x.id)) continue;
        if (filter && !x.url.includes(filter)) continue;
        seen.add(x.id);
        list.push(x);
      }
    }
    if (list.length >= n) break;
  }
  let tin = 0, tout = 0;
  for (const x of list.slice(0, n)) {
    const t = Date.now();
    const r = await checkStudio(x);
    tin += r?.usage?.input_tokens || 0;
    tout += r?.usage?.output_tokens || 0;
    console.log(`${r ? r.verdict : '写真なし'}\t${r ? r.reason : ''}\t写真${r ? r.images : 0}枚\t${((Date.now() - t) / 1000).toFixed(1)}秒\t${x.floor || ''} ${x.area}㎡ ${x.name || ''}\t${x.url}`);
  }
  console.log(`入力 ${tin} トークン・出力 ${tout} トークン`);
})().catch((e) => { console.error('失敗:', e.status || '', e.message); process.exit(1); });
