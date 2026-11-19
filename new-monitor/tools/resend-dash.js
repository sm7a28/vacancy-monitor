// 保存済みの結果（results/日付.json.enc）をダッシュボードに送り直す。
// 表示の項目を足したときに、既に載っている物件にも写真・実績ビルの場所などを入れるためのもの。
// 使い方: node new-monitor/tools/resend-dash.js 2026-11-19
// 鍵は new-monitor/.secrets/（nm-key.txt・dash-token.txt）から読む。値は表示しない。
'use strict';
const fs = require('fs');
const path = require('path');
const { readEnc, loadKey } = require('../lib/store');

const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) { console.error('日付を 2026-11-19 の形で渡してください'); process.exit(1); }
const sec = (f) => fs.readFileSync(path.join(__dirname, '..', '.secrets', f), 'utf8').trim();
const key = loadKey();
const token = sec('dash-token.txt');
const url = process.env.NM_DASH_URL || 'https://bukken.sevenart-projects.com';

(async () => {
  const data = readEnc(path.join(__dirname, '..', 'results', `${day}.json.enc`), key, { runs: [] });
  for (const run of data.runs) {
    const events = run.events.map((ev) => ({ ...ev, listing: ev.listing ? { ...ev.listing, images: (ev.listing.images || []).slice(0, 4) } : undefined }));
    const summary = { ...run.summary, sources: Object.fromEntries(Object.entries(run.summary.sources || {}).map(([k, v]) => { const { pageLog, ...rest } = v; return [k, rest]; })) };
    const res = await fetch(`${url}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nm-token': token }, body: JSON.stringify({ summary, events }) });
    console.log(run.summary.at, events.length, '件 →', res.status, (await res.text()).slice(0, 80));
  }
})();
