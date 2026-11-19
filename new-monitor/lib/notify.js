// 知らせる文面を作る。Discord に送るのは NM_NOTIFY=1 のときだけ（試運転中は送らず、結果ファイルに残すだけ）。
'use strict';

const man = (yen) => (yen ? `${Math.round(yen / 1000) / 10}万円` : '-');

function stationLine(x) {
  return (x.stations || []).filter((s) => s.station).slice(0, 3).map((s) => `${s.station}${s.walk != null ? ` 徒歩${s.walk}分` : ''}`).join('・');
}

function mapLink(x) {
  const q = x.name ? `${x.address} ${x.name}` : x.address;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || '')}`;
}

function format(ev) {
  const x = ev.listing || {};
  const head = ev.label ? `【${ev.label}】` : '【向いてる物件】';
  const lines = [];
  lines.push(`【新監視】${head}${ev.kindLabel ? `【${ev.kindLabel}】` : ''}${x.name || x.title || ''}`);
  if (ev.type === 'homes') {
    lines.push(`HOMES の建物ページに新しい募集：${ev.buildingName}`);
    lines.push(`${ev.room.floor} ${ev.room.area} ${ev.room.madori} ${ev.room.rent}（管理費 ${ev.room.admin || '-'}）`);
    lines.push(ev.room.url);
    lines.push(`建物ページ：${ev.buildingUrl}`);
    if (ev.buildingKey) lines.push(`場所：${String(ev.buildingKey).replace(/^東京都|^神奈川県/, '')}`);
    for (const s of (ev.spaces || []).slice(0, 3)) lines.push(`既存スペース：${s.name} ${s.url}`);
    if (ev.inquired) lines.push(`${ev.inquired.same === 'listing' ? '問い合わせ済み' : '同じ建物に問い合わせ済み'}（${ev.inquired.asked}：${ev.inquired.result}）`);
  } else {
    lines.push(`${x.kind || ''} ${x.address || ''}`.trim());
    lines.push(`${stationLine(x)}`);
    lines.push(`家賃 ${man(x.rent)}＋管理費等 ${man(x.admin)}＝${man(ev.judge.total)}／${x.area}㎡／坪 ${man(ev.judge.tsubo)}${x.floor ? `／${x.floor}` : ''}${x.madori ? `／${x.madori}` : ''}`);
    if (x.posted) lines.push(`掲載：${x.posted}`);
    if (ev.judge.tags.length) lines.push(`メモ：${ev.judge.tags.join('・')}`);
    if (ev.match && ev.match.reason) lines.push(`照合：${ev.match.reason}`);
    if (ev.match && ev.match.building) {
      const b = ev.match.building;
      for (const s of (b.spaces || []).slice(0, 3)) lines.push(`既存スペース：${s.name} ${s.url}`);
    }
    if (ev.alsoOn) lines.push(`ほかのサイトにも掲載：${ev.alsoOn}`);
    if (ev.priceDrop) lines.push(`値下げ：${man(ev.priceDrop.from)}→${man(ev.priceDrop.to)}`);
    if (ev.relist) lines.push(`再掲（前に見た募集と同じ部屋）`);
    lines.push(x.url);
    lines.push(`地図：${mapLink(x)}`);
    if (ev.salonUrl) lines.push(`駅のサロン検索：${ev.salonUrl}`);
  }
  if (process.env.NM_DASH_URL) lines.push(`一覧：${process.env.NM_DASH_URL}/`);
  return lines.join('\n');
}

async function send(text, webhook) {
  if (!webhook) return false;
  const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
  return res.ok;
}

module.exports = { format, send, mapLink };
