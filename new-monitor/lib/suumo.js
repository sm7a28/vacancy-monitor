// SUUMO の賃貸の一覧（事務所利用可・新着順）を取って、部屋ごとに取り出す。
'use strict';
const { getText, sleep, nfkc, stripTags, parseYen, parseArea, parseAddress } = require('./util');

const COMMON = 'ar=030&bs=040&cb=0.0&ct=20.0&co=1&et=9999999&cn=9999999&mb=0&mt=9999999&shkr1=03&shkr2=03&shkr3=03&shkr4=03&tc=0401104&po1=09&pc=50&fw2=';

// 東京都：23区のうち葛飾・江戸川を除く、多摩の市（島しょ・西多摩の町村は除く）
const TOKYO_SC = [];
for (let c = 13101; c <= 13121; c++) TOKYO_SC.push(c);
for (let c = 13201; c <= 13215; c++) TOKYO_SC.push(c);
TOKYO_SC.push(13218, 13219, 13220, 13221, 13222, 13223, 13224, 13225, 13227, 13228, 13229);
// 神奈川県：川崎市 川崎区・幸区・中原区・高津区、横浜市 青葉区・都筑区（駅で絞るのは area.js）
const KANAGAWA_SC = [14131, 14132, 14133, 14134, 14117, 14118];

const SEARCHES = [
  { key: 'suumo-tokyo', ta: 13, sc: TOKYO_SC },
  { key: 'suumo-kanagawa', ta: 14, sc: KANAGAWA_SC },
];

// 「新着順」は取るたびに並びが入れ替わるので、新着の見分けには使えない（2026-11-19 確認）。
// 代わりに SUUMO の「本日の新着物件」（tc=0401303）で絞り、毎回すべてのページを読む。
// 朝一番の回だけ「新着(2-7日前)」（tc=0401304）も足して、前の晩に出た分を拾う。
function searchUrl(s, page, opts = {}) {
  const sc = s.sc.map((c) => `sc=${c}`).join('&');
  const fresh = opts.recent ? '&tc=0401304' : '&tc=0401303';
  return `https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ta=${s.ta}&${sc}&${COMMON}${fresh}${page > 1 ? `&page=${page}` : ''}`;
}

function pick(re, s) {
  const m = s.match(re);
  return m ? m[1] : '';
}

function parseStations(cols) {
  const out = [];
  for (const raw of cols) {
    const t = nfkc(stripTags(raw));
    // 「東京メトロ日比谷線/八丁堀駅 歩4分」
    const m = t.match(/^(.*?)\/(.+?)駅\s*歩(\d+)分/);
    if (m) out.push({ line: m[1], station: m[2], walk: parseInt(m[3], 10) });
    else if (t) out.push({ line: '', station: '', walk: null, raw: t });
  }
  return out;
}

function parsePage(html) {
  const rooms = [];
  const hit = parseInt((html.match(/paginate_set-hit">\s*([\d,]+)/) || [])[1]?.replace(/,/g, '') || 'NaN', 10);
  const parts = html.split('<div class="cassetteitem">').slice(1);
  for (const part of parts) {
    const kind = stripTags(pick(/cassetteitem_content-label">([\s\S]*?)<\/div>/, part));
    const name = nfkc(stripTags(pick(/cassetteitem_content-title">([\s\S]*?)<\/div>/, part)));
    const address = nfkc(stripTags(pick(/cassetteitem_detail-col1">([\s\S]*?)<\/li>/, part)));
    const col2 = pick(/cassetteitem_detail-col2">([\s\S]*?)<\/li>/, part);
    const stations = parseStations([...col2.matchAll(/cassetteitem_detail-text">([\s\S]*?)<\/div>/g)].map((m) => m[1]));
    const col3 = stripTags(pick(/cassetteitem_detail-col3">([\s\S]*?)<\/li>/, part));
    const age = parseInt((nfkc(col3).match(/築(\d+)年/) || [])[1] || (/新築/.test(col3) ? '0' : 'NaN'), 10);
    const stories = nfkc(col3).match(/(?:地下(\d+)地上)?(\d+)階建/);
    const bodies = part.split('<tr class="js-cassette_link">').slice(1);
    for (const b of bodies) {
      const bc = pick(/name="bc"[^>]*value="(\d+)"/, b);
      if (!bc) continue;
      const tds = [...b.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const floor = nfkc(stripTags(tds[2] || ''));
      const rent = parseYen(stripTags(pick(/cassetteitem_price--rent">([\s\S]*?)<\/span><\/span>/, b) || pick(/cassetteitem_price--rent">([\s\S]*?)<\/li>/, b)));
      const admin = parseYen(stripTags(pick(/cassetteitem_price--administration">([\s\S]*?)<\/span>/, b)));
      const madori = stripTags(pick(/cassetteitem_madori">([\s\S]*?)<\/span>/, b));
      const area = parseArea(stripTags(pick(/cassetteitem_menseki">([\s\S]*?)<\/span>/, b)));
      const href = pick(/href="(\/chintai\/[a-z]+_\d+\/\?bc=\d+)"/, b);
      const imgs = (pick(/data-imgs="([^"]*)"/, b) || '').split(',').filter(Boolean);
      const tags = [...b.matchAll(/cassetteitem-tag">([\s\S]*?)<\/span>/g)].map((m) => stripTags(m[1]));
      rooms.push({
        site: 'suumo',
        id: `suumo:${bc}`,
        url: href ? `https://suumo.jp${href}` : `https://suumo.jp/chintai/bc_${bc}/`,
        kind, name, address, addr: parseAddress(address), stations,
        builtAgeYears: Number.isNaN(age) ? null : age,
        stories: stories ? parseInt(stories[2], 10) : null,
        basement: stories && stories[1] ? parseInt(stories[1], 10) : 0,
        floor, rent, admin, madori, area, images: imgs.slice(0, 30), tags,
      });
    }
  }
  return { hit, rooms, buildings: parts.length };
}

// 新着の絞り込み（本日／2-7日前）の結果を、最後のページまで読む（最大 maxPages）
async function fetchSearch(s, seen, opts = {}) {
  const maxPages = opts.maxPages || 20;
  const log = [];
  const all = [];
  let hit = null;
  for (let page = 1; page <= maxPages; page++) {
    const url = searchUrl(s, page, opts);
    const r = await getText(url);
    const p = parsePage(r.text);
    if (page === 1) hit = p.hit;
    const fresh = p.rooms.filter((x) => !seen.has(x.id));
    log.push({ page, status: r.status, rooms: p.rooms.length, fresh: fresh.length, error: /エラー｜SUUMO/.test(r.text) || undefined });
    all.push(...p.rooms);
    if (r.status !== 200 || p.rooms.length === 0) break;
    if (p.buildings < 50) break; // 最後のページ（1ページ50棟）
    await sleep(opts.delayMs ?? 4000);
  }
  return { key: s.key, hit, log, rooms: all };
}

// 物件ページの「情報更新日」を取る（一覧には載っていない）
async function fetchDetail(url) {
  const r = await getText(url);
  if (r.status !== 200) return { status: r.status, updated: '' };
  const t = stripTags(r.text.replace(/<script[\s\S]*?<\/script>/g, ''));
  const m = t.match(/情報更新日\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  return { status: r.status, updated: m ? `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}` : '' };
}

module.exports = { SEARCHES, searchUrl, parsePage, fetchSearch, fetchDetail };
