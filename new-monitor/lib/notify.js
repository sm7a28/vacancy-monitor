// 知らせる文面を作る。Discord に送るのは NM_NOTIFY=1 のときだけ（試運転中は送らず、結果ファイルに残すだけ）。
'use strict';

const man = (yen) => (yen ? `${Math.round(yen / 1000) / 10}万円` : '-');

// 駅の乗降客数（1日あたり・2024年度、国土数値情報。tools/make-ridership.js で作る）
// 2026-11-21 ユーザー「最寄り駅の乗降客数のってなくないか」（ヒットの報告に必ず添える項目）
const { normStation } = require('./area');
let RIDERSHIP = {};
try { RIDERSHIP = require('../data/ridership.json').stations || {}; } catch (e) { /* 表がなくても通知は送る */ }
// 表記ゆれ（四谷↔四ツ谷、ヶ↔が、の↔ノ、「押上（スカイツリー前）」のかっこ）を吸収して引く
const STATION_ALIAS = { 四谷: '四ツ谷' };
function lookupRidership(name) {
  const base = normStation(String(name || '').replace(/[（(].*$/, ''));
  const tries = [base, STATION_ALIAS[base], base.replace(/が/g, 'ケ'), base.replace(/ケ/g, 'が'), base.replace(/の/g, 'ノ'), base.replace(/ノ/g, 'の')];
  for (const t of tries) if (t && RIDERSHIP[t]) return RIDERSHIP[t];
  return 0;
}
function ridership(name) {
  const n = lookupRidership(name);
  if (!n) return '';
  return n >= 10000 ? `乗降${(n / 10000).toFixed(1)}万人` : `乗降${n.toLocaleString('ja-JP')}人`;
}

function stationLine(x) {
  return (x.stations || []).filter((s) => s.station).slice(0, 3).map((s) => {
    const r = ridership(s.station);
    return `${s.station}${s.walk != null ? ` 徒歩${s.walk}分` : ''}${r ? `（${r}）` : ''}`;
  }).join('・');
}

function mapLink(x) {
  const q = x.name ? `${x.address} ${x.name}` : x.address;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || '')}`;
}

// 既存スペース（2026-11-20 ユーザー「実績アリは既存店のリンクがほしい。最低限店舗名はいる」）
// URL が分からないスペース（古い監視のリストの多く）は、名前と住所の Google 検索に飛ばす
function spaceUrl(s, b) {
  if (s.url) return s.url;
  return `https://www.google.com/search?q=${encodeURIComponent(`${s.name} ${(b && (b.address || b.key)) || ''}`.trim())}`;
}
// 照合した建物（実績ビル？は同じ丁目の候補すべて）の既存スペースを {name, url, building} で返す
function existingSpaces(ev) {
  if (ev.type === 'homes') return (ev.spaces || []).slice(0, 5).map((s) => ({ name: s.name, url: spaceUrl(s, { key: ev.buildingKey }), searched: !s.url }));
  const m = ev.match || {};
  if (!m.building) return [];
  const many = /？$/.test(m.label || '') && (m.others || []).length > 1;
  const bs = many ? m.others.slice(0, 3) : [m.building];
  const out = [];
  for (const b of bs) for (const s of (b.spaces || []).slice(0, many ? 2 : 4)) out.push({ name: s.name, url: spaceUrl(s, b), searched: !s.url, building: many ? (b.name || String(b.key || '').replace(/^東京都|^神奈川県/, '')) : '' });
  return out;
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
    for (const sp of existingSpaces(ev)) lines.push(`既存スペース：${sp.name}${sp.searched ? '（URL不明・検索）' : ''} ${sp.url}`);
    if (ev.inquired) lines.push(`${ev.inquired.same === 'listing' ? '問い合わせ済み' : '同じ建物に問い合わせ済み'}（${ev.inquired.asked}：${ev.inquired.result}）`);
  } else {
    lines.push(`${x.kind || ''} ${x.address || ''}`.trim());
    lines.push(`${stationLine(x)}`);
    lines.push(`家賃 ${man(x.rent)}＋管理費等 ${man(x.admin)}＝${man(ev.judge.total)}／${x.area}㎡／坪 ${man(ev.judge.tsubo)}${x.floor ? `／${x.floor}` : ''}${x.madori ? `／${x.madori}` : ''}`);
    if (x.posted) lines.push(`掲載：${x.posted}`);
    if (ev.judge.tags.length) lines.push(`メモ：${ev.judge.tags.join('・')}`);
    if (ev.match && ev.match.reason) lines.push(`照合：${ev.match.reason}`);
    for (const sp of existingSpaces(ev)) lines.push(`既存スペース：${sp.building ? `（${sp.building}）` : ''}${sp.name}${sp.searched ? '（URL不明・検索）' : ''} ${sp.url}`);
    if (ev.alsoOn) lines.push(`ほかのサイトにも掲載：${ev.alsoOn}`);
    if (ev.priceDrop) lines.push(`値下げ：${man(ev.priceDrop.from)}→${man(ev.priceDrop.to)}`);
    if (ev.relist) lines.push(`再掲（前に見た募集と同じ部屋）`);
    lines.push(x.url);
    lines.push(`地図：${mapLink(x)}`);
    if (ev.ib) lines.push(`インスタベース（${ev.ib.station}駅・${ev.ib.genreName}）：${ev.ib.url}`);
    else if (ev.salonUrl) lines.push(`駅のサロン検索：${ev.salonUrl}`);
  }
  if (process.env.NM_DASH_URL) lines.push(`一覧：${process.env.NM_DASH_URL}/`);
  return lines.join('\n');
}

// 印と色（2026-11-20 ユーザー「物件と物件の区切りがわかりにくい」「実績アリとかA級物件は何か印付けて」）
// 1件ずつ Discord の埋め込み（左に色の帯が付くカード）で送る。リンクの自動プレビューは出ない
const GRADE = {
  // 実績ビル系は印だけ⭐でそろえ、帯の色と文字は分ける。ピンポイントは🎯・重点は🟢（2026-11-21 変更）（2026-11-20 ユーザー指示）
  '実績ビル': { mark: '⭐', color: 0xe03131 },
  '実績ビル？': { mark: '⭐', color: 0xf08c00 },
  '教室ビル': { mark: '⭐', color: 0x9c36b5 },
  '教室ビル？': { mark: '⭐', color: 0xcc5de8 },
  pinpoint: { mark: '🎯', color: 0xf59f00, name: '一等地' }, // 表示名は「一等地」（2026-11-21 ユーザー指示。中では pinpoint のまま）
  focus: { mark: '🟢', color: 0x1c7ed6, name: '重点' },
  normal: { mark: '⚪', color: 0x868e96, name: '向いてる物件' },
};
const SITE = { suumo: 'SUUMO', athome: 'アットホーム', homes: 'HOMES' };

function grade(ev) {
  if (ev.label && GRADE[ev.label]) return { ...GRADE[ev.label], name: ev.label };
  const t = (ev.judge && ev.judge.tier) || 'normal';
  return GRADE[t] || GRADE.normal;
}

const link = (label, url) => (url ? `[${label}](${url})` : '');

// スタジオに使えそうな地下（20㎡以上）は題名にも印を出す（2026-11-21 ユーザー「スタジオに使えそうな地下もわかりやすくして」）
const STUDIO_BASEMENT_MIN_AREA = 20;
function extra(ev) {
  const x = ev.listing || {};
  const tags = (ev.judge && ev.judge.tags) || [];
  if (tags.includes('地下') && x.area >= STUDIO_BASEMENT_MIN_AREA) return '🤩【地下・スタジオ向き】';
  return '';
}

function embed(ev) {
  const x = ev.listing || {};
  const g = grade(ev);
  const d = [];
  let title;
  let url;
  let image = '';
  if (ev.type === 'homes') {
    title = `${g.mark}【${g.name}】${ev.buildingName || ''}`;
    url = ev.room.url;
    d.push('**HOMES の建物ページに新しい募集**');
    d.push(`${ev.room.floor} ${ev.room.area} ${ev.room.madori} ${ev.room.rent}（管理費 ${ev.room.admin || '-'}）`);
    if (ev.buildingKey) d.push(`場所：${String(ev.buildingKey).replace(/^東京都|^神奈川県/, '')}`);
    for (const sp of existingSpaces(ev)) d.push(`既存スペース：${link(sp.name, sp.url)}${sp.searched ? '（URL不明・検索）' : ''}`);
    if (ev.inquired) d.push(`${ev.inquired.same === 'listing' ? '問い合わせ済み' : '同じ建物に問い合わせ済み'}（${ev.inquired.asked}：${ev.inquired.result}）`);
    d.push(link('建物ページ', ev.buildingUrl));
  } else {
    title = `${extra(ev)}${g.mark}【${g.name}】${ev.kindLabel ? `【${ev.kindLabel}】` : ''}${x.name || x.title || ''}`;
    url = x.url;
    image = (x.images || [])[0] || '';
    d.push(`**${man(ev.judge.total)}**（家賃 ${man(x.rent)}＋管理費等 ${man(x.admin)}）／**${x.area}㎡**／坪 ${man(ev.judge.tsubo)}${x.floor ? `／${x.floor}` : ''}${x.madori ? `／${x.madori}` : ''}`);
    for (const sp of existingSpaces(ev)) d.push(`既存スペース：${sp.building ? `（${sp.building}）` : ''}${link(sp.name, sp.url)}${sp.searched ? '（URL不明・検索）' : ''}`);
    d.push(stationLine(x));
    d.push(`${x.kind || ''} ${x.address || ''}`.trim());
    if (x.posted) d.push(`掲載：${x.posted}`);
    if (ev.match && ev.match.reason) d.push(`照合：${ev.match.reason}`);
    if (ev.judge.tags.length) d.push(`メモ：${ev.judge.tags.join('・')}`);
    if (ev.alsoOn) d.push(`ほかのサイトにも掲載：${ev.alsoOn}`);
    if (ev.priceDrop) d.push(`値下げ：${man(ev.priceDrop.from)}→${man(ev.priceDrop.to)}`);
    if (ev.relist) d.push('再掲（前に見た募集と同じ部屋）');
    const links = [link('物件ページ', x.url), link('地図', mapLink(x))];
    if (ev.ib) links.push(link(`インスタベース（${ev.ib.station}駅・${ev.ib.genreName}）`, ev.ib.url));
    d.push(links.filter(Boolean).join('　'));
  }
  if (process.env.NM_DASH_URL) d.push(link('一覧', `${process.env.NM_DASH_URL}/`));
  const e = { title: title.slice(0, 250), url, color: g.color, description: d.filter(Boolean).join('\n').slice(0, 3800), footer: { text: `${SITE[ev.type === 'homes' ? 'homes' : x.site] || ''}${ev.type === 'homes' ? '' : '　乗降は1日あたり・2024年度（国土数値情報）'}` } };
  if (image) e.thumbnail = { url: image };
  return e;
}

// 通知の1行目（スマホの通知にも出る）
function headline(ev) {
  const g = grade(ev);
  const x = ev.listing || {};
  if (ev.type === 'homes') return `${g.mark}【${g.name}】${ev.buildingName || ''} ${ev.room.floor} ${ev.room.rent}`;
  const st = (x.stations || [])[0];
  return `${extra(ev)}${g.mark}【${g.name}】${x.name || ''} ${man(ev.judge.total)} ${x.area}㎡${st ? ` ${st.station}${st.walk != null ? `徒歩${st.walk}分` : ''}${ridership(st.station) ? `（${ridership(st.station)}）` : ''}` : ''}`;
}

async function post(webhook, body) {
  return fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function send(ev, webhook) {
  if (!webhook) return false;
  if (typeof ev === 'string') return (await post(webhook, { content: ev.slice(0, 1900) })).ok;
  let res = await post(webhook, { content: headline(ev).slice(0, 300), embeds: [embed(ev)] });
  // 埋め込みが弾かれたら、文字だけ（リンクのプレビューなし）で送り直す
  if (res.status === 400) res = await post(webhook, { content: (ev.text || format(ev)).slice(0, 1900), flags: 4 });
  return res.ok;
}

module.exports = { format, send, mapLink, embed, headline };
