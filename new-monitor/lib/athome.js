// アットホームの事業用（貸事務所・貸店舗・倉庫）の一覧を新着順で取って、1件ずつ取り出す。
// アットホームは同じ接続から続けて取ると5〜6回目で認証画面が出る（2026-11-19 確認）。
// 認証画面は突破しない。1回の巡回で取るのは MAX_REQUESTS ページまでにし、認証画面が出たらその回は止める。
'use strict';
const { getText, sleep, nfkc, stripTags, parseYen, parseArea, parseAddress } = require('./util');

const MAX_REQUESTS = 4;
// URLの形は、保存した検索条件（倉庫）を開いたときの本物のURLにそろえる（2026-11-19 確認）。
// basic=kc501（下限なし）,kc603（20万円以下）,kt223（10㎡以上）,kf101,ke004（徒歩10分以内）,kn001,kj001
// 効いているかは run.js で結果から確かめる（overPrice・overWalk・underArea）。
const BASIC = 'kc501,kc603,kt223,kf101,ke004,kn001,kj001';
// 東京都：葛飾区・江戸川区（荒川より東）を除く23区と多摩の市
const TOKYO_CITIES = 'chiyoda,chuo,minato,shinjuku,bunkyo,taito,sumida,koto,shinagawa,meguro,ota,setagaya,shibuya,nakano,suginami,toshima,kita,arakawa,itabashi,nerima,adachi,hachioji,tachikawa,musashino,mitaka,ome,tokyo_fuchu,akishima,chofu,machida,koganei,kodaira,hino,higashimurayama,kokubunji,kunitachi,fussa,komae,higashiyamato,kiyose,higashikurume,musashimurayama,tama,inagi,hamura,akiruno,nishitokyo';
const TOKYO_CDS = '13101,13102,13103,13104,13105,13106,13107,13108,13109,13110,13111,13112,13113,13114,13115,13116,13117,13118,13119,13120,13121,13201,13202,13203,13204,13205,13206,13207,13208,13209,13210,13211,13212,13213,13214,13215,13218,13219,13220,13221,13222,13223,13224,13225,13227,13228,13229';
const tokyoQ = `pref=13&cities=${TOKYO_CITIES}&cityCds=${TOKYO_CDS}&basic=${BASIC}&tsubo=0&tanka=0&kod=&q=1&sort=33`;
const kanagawaQ = `pref=14&basic=${BASIC}&tsubo=0&tanka=0&kod=&q=1&sort=33`;

const TOKYO = [
  { key: 'athome2-office-tokyo', url: `https://www.athome.co.jp/rent_office/tokyo/list/?${tokyoQ}` },
  { key: 'athome2-store-tokyo', url: `https://www.athome.co.jp/rent_store/tokyo/list/?${tokyoQ}` },
  { key: 'athome2-souko-tokyo', url: `https://www.athome.co.jp/rent_souko/tokyo/list/?${tokyoQ}` },
];
// 神奈川は1回に1種類ずつ順番に回す（回数の上限のため）
const KANAGAWA = [
  { key: 'athome2-office-kanagawa', url: `https://www.athome.co.jp/rent_office/kanagawa/list/?${kanagawaQ}` },
  { key: 'athome2-store-kanagawa', url: `https://www.athome.co.jp/rent_store/kanagawa/list/?${kanagawaQ}` },
  { key: 'athome2-souko-kanagawa', url: `https://www.athome.co.jp/rent_souko/kanagawa/list/?${kanagawaQ}` },
];

function plan(runIndex) {
  return [...TOKYO, KANAGAWA[runIndex % KANAGAWA.length]].slice(0, MAX_REQUESTS);
}

function parsePage(html) {
  const items = [];
  const blocked = /認証にご協力ください/.test(html);
  const cards = html.split(/<a [^>]*class="card-box__area"/).slice(1);
  for (const c of cards) {
    const id = (c.match(/href="\/rent_[a-z]+\/(\d{6,})\//) || [])[1];
    if (!id) continue;
    const cat = (c.match(/href="\/(rent_[a-z]+)\/\d+/) || [])[1] || '';
    const title = nfkc(stripTags((c.match(/area-title__text">([\s\S]*?)<\/span>/) || [])[1]));
    const syumoku = nfkc(stripTags((c.match(/area-title__syumoku">([\s\S]*?)<\/span>/) || [])[1]));
    const tr = (c.match(/<tr[^>]*class="tr-top"[^>]*>([\s\S]*?)<\/tr>/) || [])[1] || '';
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => nfkc(stripTags(m[1])));
    // tds[0] = 「大久保/JR総武線\n徒歩2分\n新宿区百人町2丁目」
    const l0 = (tds[0] || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const stations = [];
    let address = '';
    for (let i = 0; i < l0.length; i++) {
      const s = l0[i];
      const sm = s.match(/^(.+?)\/(.+)$/);
      if (sm) {
        const walkLine = l0[i + 1] || '';
        const wm = walkLine.match(/徒歩(\d+)分/);
        stations.push({ station: sm[1].replace(/駅$/, ''), line: sm[2], walk: wm ? parseInt(wm[1], 10) : null, raw: walkLine });
        if (wm || /バス/.test(walkLine)) i++;
      } else if (/[区市町村]/.test(s)) {
        address = s;
      }
    }
    const l1 = (tds[1] || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const rent = parseYen(l1[0] || '');
    const admin = l1[1] != null ? parseYen(l1[1]) : 0;
    const l3 = (tds[3] || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const area = parseArea(l3[0] || '');
    const built = (tds[4] || '').match(/(\d{4})年(\d+)月/);
    const shop = nfkc(stripTags((c.match(/shop-comment__photo-area">([\s\S]*?)<\/div>/) || [])[1]));
    // 題名が「新宿区 百人町2丁目(大久保駅) の貸事務所」の形でなければ、建物名（＋階・部屋番号）が載っている
    let name = '', floor = '';
    if (title && !/\)\s*の(貸|売|倉庫|店舗|事務所)/.test(title)) {
      const fm = title.match(/\s(B?\d+)階\S*$/i) || title.match(/\s(B?\d+)F$/i);
      const rm = title.match(/\s(B?)(\d{1,2})\d{2}(号室)?$/i);
      if (fm) floor = `${fm[1]}階`;
      else if (rm) floor = `${rm[1]}${rm[2]}階`;
      name = title.replace(/\s+(B?\d+階\S*|B?\d+F|B?\d{3,4}(号室)?)$/i, '').trim();
    }
    items.push({
      site: 'athome',
      id: `athome:${id}`,
      url: `https://www.athome.co.jp/${cat}/${id}/`,
      kind: syumoku, title, name, address, addr: parseAddress(address), stations,
      rent, admin: Number.isNaN(admin) ? 0 : admin, area,
      built: built ? `${built[1]}-${String(built[2]).padStart(2, '0')}` : null,
      floor, shop,
    });
  }
  return { blocked, items };
}

async function fetchAll(runIndex, opts = {}) {
  const out = [];
  let blocked = false;
  const list = plan(runIndex);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (blocked) { out.push({ key: s.key, skipped: 'blocked-earlier', items: [] }); continue; }
    const r = await getText(s.url);
    const p = parsePage(r.text);
    out.push({ key: s.key, status: r.status, blocked: p.blocked, items: p.items });
    if (p.blocked) blocked = true;
    if (i < list.length - 1) await sleep(opts.delayMs ?? 30000);
  }
  return { blocked, results: out };
}

module.exports = { plan, parsePage, fetchAll, MAX_REQUESTS };
