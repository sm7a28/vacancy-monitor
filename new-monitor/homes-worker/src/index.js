// HOMES の建物ページ（https://www.homes.co.jp/archive/b-<番号>/）を取り、
// 「募集中の部屋」の欄と建物の概要だけを切り出して JSON で返す。
// GitHub Actions からは HOMES に弾かれるため、取得だけを Cloudflare Workers で行う。
// 合言葉（NM_HOMES_TOKEN）がないと答えない。HOMES の建物ページ以外は取らない。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function text(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function slice(html, startMarker, endMarkers, max) {
  const i = html.indexOf(startMarker);
  if (i < 0) return '';
  let j = -1;
  for (const m of endMarkers) {
    const k = html.indexOf(m, i + startMarker.length);
    if (k > 0 && (j < 0 || k < j)) j = k;
  }
  if (j < 0) j = i + max;
  return html.slice(i, Math.min(j, i + max));
}

function parseRooms(sec) {
  const rooms = [];
  const seen = new Set();
  // 部屋のリンクは「/chintai/room/<英数>/」と「/chintai/b-<数字>/」（事業用など）の2通り
  const parts = sec.split(/<a\s+href="https:\/\/www\.homes\.co\.jp\/chintai\//);
  for (const p of parts.slice(1)) {
    const hash = (p.match(/^(room\/[0-9a-f]+|b-\d+)\//) || [])[1];
    if (!hash || seen.has(hash)) continue;
    // 1件分のカード（詳細のリンクまで）
    const end = p.indexOf('空室状況を確認する');
    const card = end > 0 ? p.slice(0, end) : p.slice(0, 6000);
    if (!/募集中/.test(card) && !/万円/.test(card)) continue;
    seen.add(hash);
    const lis = [...card.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
    const rent = (card.match(/font-bold">\s*([\d.]+)\s*<\/span>\s*万円/) || [])[1];
    const admin = text((card.match(/管理費：([^<]*)</) || [])[1]);
    const status = text((card.match(/<span[^>]*>(賃貸[^<]*)<\/span>/) || [])[1]);
    rooms.push({
      url: `https://www.homes.co.jp/chintai/${hash}/`,
      floor: lis.find((s) => /階/.test(s)) || '',
      area: lis.find((s) => /m²|㎡/.test(s)) || '',
      madori: lis.find((s) => /[0-9]?[SLDKR]+|ワンルーム/.test(s) && !/階|m²/.test(s)) || '',
      rent: rent ? `${rent}万円` : '',
      admin,
      status,
      isNew: /\bNEW\b/.test(card),
    });
  }
  return rooms;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.NM_HOMES_TOKEN || request.headers.get('x-nm-token') !== env.NM_HOMES_TOKEN) {
      return new Response('forbidden', { status: 403 });
    }
    if (url.pathname !== '/homes') return new Response('not found', { status: 404 });
    const b = url.searchParams.get('b') || '';
    if (!/^\d{3,12}$/.test(b)) return new Response('bad request', { status: 400 });
    const target = `https://www.homes.co.jp/archive/b-${b}/`;
    let r;
    try {
      r = await fetch(target, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, redirect: 'follow' });
    } catch (e) {
      return Response.json({ b, ok: false, error: String(e) });
    }
    const html = await r.text();
    const title = text((html.match(/<title>([^<]*)<\/title>/) || [])[1]).slice(0, 120);
    const captcha = /captcha|認証にご協力|アクセスが集中/i.test(html.slice(0, 20000)) && !/archive/.test(title);
    const roomSec = slice(html, 'id="anchor-roomInfo_faq"', ['id="anchor-buildingInfo"', 'id="anchor-buildingHistories"'], 150000);
    const bldSec = slice(html, 'id="anchor-buildingInfo"', ['id="anchor-buildingHistories"', 'id="anchor-reports"'], 40000);
    const roomText = text(roomSec);
    const none = /募集中の部屋情報はありません/.test(roomText);
    const count = none ? 0 : parseInt((roomText.match(/募集中\s*(\d+)\s*件/) || [])[1] || '0', 10);
    // 募集中がないときは同じ欄に「周辺の問合せ可能な物件」（別の建物）が並ぶので、そこから先は読まない
    let own = roomSec;
    for (const m of ['周辺の問合せ可能', '周辺の募集中の物件', '希望のお部屋が見つからない']) {
      const k = own.indexOf(m);
      if (k > 0) own = own.slice(0, k);
    }
    const bt = text(bldSec);
    const pick = (re) => ((bt.match(re) || [])[1] || '').trim();
    return Response.json({
      b,
      ok: r.status === 200 && !captcha,
      status: r.status,
      captcha,
      title,
      size: html.length,
      hasRoomSection: roomSec.length > 0,
      count,
      none,
      rooms: none || count === 0 ? [] : parseRooms(own),
      building: {
        kind: pick(/物件種別\s*(\S+)/),
        built: pick(/築年月\(築年数\)\s*([^\n(（]+)/),
        structure: pick(/建物構造\s*([^\n]+?)\s*建物階数/),
        floors: pick(/建物階数\s*([\s\S]+?)(?:\s*この建物|\s*設備|$)/).replace(/\s+/g, ''),
      },
    });
  },
};
