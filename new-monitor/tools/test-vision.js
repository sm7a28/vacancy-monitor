// 写真の判定（lib/vision.js）の試し。最新の結果ファイルから物件を選んで判定し、結果を表示する。
// 使い方：node new-monitor/tools/test-vision.js [件数] [named|noname|all]
//   named  … 募集に建物名が載っている物件（写真から読んだ名前と見比べて、読み取りの正しさを測る）
//   noname … 建物名が載っていない物件（写真から名前が読めれば、実績ビルとの照合が進む）
// ANTHROPIC_API_KEY が要る（値は表示しない）。
'use strict';
const fs = require('fs');
const path = require('path');
const { loadKey, readEnc } = require('../lib/store');
const { analyze, hasRealName } = require('../lib/vision');
const { normName } = require('../lib/match');

(async () => {
  const n = parseInt(process.argv[2] || '5', 10);
  const mode = process.argv[3] || 'all';
  const dir = path.join(__dirname, '..', 'results');
  const key = loadKey();
  const seen = new Set();
  const list = [];
  for (const f of fs.readdirSync(dir).sort().reverse()) {
    for (const run of readEnc(path.join(dir, f), key).runs.slice().reverse()) {
      for (const ev of run.events) {
        const x = ev.listing;
        if (!x || !(x.images || []).length || seen.has(x.id)) continue;
        const named = hasRealName(x);
        if ((mode === 'named' && !named) || (mode === 'noname' && named)) continue;
        // 同じ建物の部屋ばかりにならないように
        const bkey = `${x.name}|${x.address}`;
        if (seen.has(bkey)) continue;
        seen.add(x.id); seen.add(bkey);
        list.push(x);
      }
    }
    if (list.length >= n) break;
  }
  let tin = 0, tout = 0, read = 0, right = 0;
  for (const x of list.slice(0, n)) {
    const t = Date.now();
    const r = await analyze(x);
    tin += r?.usage?.input_tokens || 0;
    tout += r?.usage?.output_tokens || 0;
    let check = '';
    if (r && r.buildingName) {
      read++;
      if (hasRealName(x)) { const ok = normName(r.buildingName) === normName(x.name); if (ok) right++; check = ok ? '一致' : '不一致'; }
    }
    console.log([r ? r.studio : '写真なし', r ? r.studioReason : '', `建物名「${r ? r.buildingName : ''}」${r && r.buildingNameWhere ? `(${r.buildingNameWhere})` : ''}${check ? ` ${check}` : ''}`, `${r ? r.floors : 0}階`, `募集の名前「${x.name || ''}」`, `${x.stories || '?'}階建`, `${((Date.now() - t) / 1000).toFixed(1)}秒`, x.url].join('\t'));
  }
  console.log(`建物名を読めた ${read}/${Math.min(n, list.length)} 件${mode === 'named' ? `（募集の名前と一致 ${right}）` : ''}　入力 ${tin} トークン・出力 ${tout} トークン`);
})().catch((e) => { console.error('失敗:', e.status || '', e.message); process.exit(1); });
