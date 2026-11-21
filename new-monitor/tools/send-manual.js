// 手作業で探した物件を、いつもの監視と同じカードで Discord に送る（GitHub Actions の new-monitor-send から動かす）。
// 送る中身は new-monitor/data/manual-send.json.enc（暗号化。{ events: [...] }）。webhook は secret の DISCORD_WEBHOOK_URL。
// 2026-11-21 ユーザー「条件合致のDiscordに投げられるか？」（祐天寺3分・7万円以下の検索から）
'use strict';
const path = require('path');
const { loadKey, readEnc } = require('../lib/store');
const notify = require('../lib/notify');

(async () => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL がありません');
  const data = readEnc(path.join(__dirname, '..', 'data', 'manual-send.json.enc'), loadKey());
  let sent = 0;
  for (const ev of data.events || []) {
    if (await notify.send(ev, webhook)) sent++;
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`送信 ${sent}/${(data.events || []).length} 件`);
  if (sent !== (data.events || []).length) process.exitCode = 1;
})();
