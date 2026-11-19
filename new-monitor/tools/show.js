// 結果（暗号化）を手元で読む。使い方: node new-monitor/tools/show.js [日付 YYYY-MM-DD] [--all]
// 既定では【実績ビル】【実績ビル？】と、重点・ピンポイントの【向いてる物件】だけを出す。--all で全部。
'use strict';
const fs = require('fs');
const path = require('path');
const { loadKey, readEnc } = require('../lib/store');

const args = process.argv.slice(2);
const all = args.includes('--all');
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const dir = process.env.NM_RESULTS_DIR || path.join(__dirname, '..', 'results');
const file = path.join(dir, `${date}.json.enc`);
if (!fs.existsSync(file)) { console.log(`${date} の結果はありません`); process.exit(0); }
const day = readEnc(file, loadKey(), { runs: [] });
for (const run of day.runs) {
  console.log(`=== 巡回 ${run.summary.at}（${run.summary.runIndex + 1}回目）`);
  for (const [k, v] of Object.entries(run.summary.sources)) {
    const { pageLog, ...rest } = v;
    console.log(`  ${k}: ${JSON.stringify(rest)}`);
  }
  const evs = run.events.filter((e) => all || e.label || e.type === 'homes' || (e.judge && e.judge.tier !== 'normal'));
  console.log(`  見つけたもの ${run.events.length} 件（表示 ${evs.length} 件）`);
  for (const e of evs) console.log(`\n${e.text}`);
}
