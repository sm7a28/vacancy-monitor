// 手元の outputs/ から候補の建物（既存スペースのある建物）を作り、暗号化して new-monitor/data/ に置く。
// 使い方: node new-monitor/tools/make-candidates.js
'use strict';
const fs = require('fs');
const path = require('path');
const { loadKey, writeEnc } = require('../lib/store');
const { parseAddress } = require('../lib/util');

const ROOT = path.join(__dirname, '..', '..');
const bc = JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', 'building-candidates.json'), 'utf8'));
const hm = JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', 'homes-match-119.json'), 'utf8'));

// 旧名など（分かったものを足していく）
const ALIASES = {
  // '今の名前': ['旧名'],
};

// HOMES の照合結果は、名前だけでなく区・町・丁目・番地まで合うものに付ける（同じ名前の別の建物があるため）
const homesList = [];
for (const x of hm) {
  const both = (x.homes || []).find((h) => h.conf === 'both');
  if (both) homesList.push({ name: x.name, ku: x.ku, cho: x.cho, c: x.c, b: x.b, href: both.href, homesName: both.name, addr: both.addr });
}
const homesByName = {
  get(name, a, banchi) {
    const k = (s) => String(s || '').replace(/[がケヶ]/g, 'ケ');
    const hits = homesList.filter((h) => h.name === name && h.ku === a.ward && k(a.town).includes(k(h.cho)) && h.c === a.chome);
    let exact = hits.find((h) => h.b == null || banchi == null || h.b === banchi);
    // 住所の書き方が崩れている候補（例「麻布十-1-5-1」）は、同じ名前が1棟しかなければ名前で付ける
    if (!exact && bc.buildings.filter((x) => x.buildingName === name).length === 1) {
      const byName = homesList.filter((h) => h.name === name);
      if (byName.length === 1) exact = byName[0];
    }
    return exact ? { href: exact.href, homesName: exact.homesName, addr: exact.addr } : null;
  },
};

const buildings = bc.buildings.map((b) => {
  const key = b.buildingKey; // 例「東京都港区南青山5-4」
  const a = parseAddress(key);
  const banchi = (key.match(/\d+-(\d+)/) || [])[1];
  const name = b.buildingName || '';
  const nameIsAddress = !name || /\d+-\d+/.test(name) || /^\S+?[区市]\S+\d/.test(name);
  const homes = homesByName.get(name, a, banchi ? parseInt(banchi, 10) : null);
  return {
    key,
    name,
    nameIsAddress,
    aliases: [...(ALIASES[name] || []), ...(homes && homes.homesName && homes.homesName !== name ? [homes.homesName] : [])],
    address: b.address,
    ward: a.ward, town: a.town, chome: a.chome, banchi: banchi ? parseInt(banchi, 10) : null,
    station: b.nearestStation, walk: b.walkMinutes,
    spaces: (b.spaces || []).map((s) => ({ name: s.name, url: s.url, category: s.category, source: s.source })),
    homes,
  };
});

const seenHref = new Set();
const homesTargets = [];
for (const b of buildings) {
  if (!b.homes || seenHref.has(b.homes.href)) continue;
  seenHref.add(b.homes.href);
  homesTargets.push({ key: b.key, name: b.name, href: b.homes.href });
}

// 駅 → インスタベースの駅コード（駅のサロン検索URL https://www.instabase.jp/tokyo-<コード>-salon を作るため）
const stationCodes = {};
try {
  const sm = JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', 'instabase-station-url-map-20260713.json'), 'utf8'));
  for (const src of [sm.matched || {}, sm.byStation || {}]) {
    for (const [st, v] of Object.entries(src)) {
      const best = Object.entries(v.codes || {}).sort((a, b) => b[1] - a[1])[0];
      if (best && !stationCodes[st]) stationCodes[st] = best[0];
    }
  }
} catch (e) { console.log('駅コードの表が読めませんでした', e.message); }

// 問い合わせ履歴（outputs/inquiries.json）。同じ物件・同じ建物の募集に印を付ける
let inquiries = [];
try {
  inquiries = JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', 'inquiries.json'), 'utf8')).inquiries.map((q) => ({ ...q, addr: parseAddress(q.address || '') }));
} catch (e) { console.log('問い合わせ履歴が読めませんでした', e.message); }

const key = loadKey();
writeEnc(path.join(__dirname, '..', 'data', 'candidates.json.enc'), { savedAt: new Date().toISOString(), buildings, homesTargets, stationCodes, inquiries }, key);
console.log(`候補の建物 ${buildings.length} 棟（名前で照合できるもの ${buildings.filter((b) => !b.nameIsAddress).length}）、HOMES の監視対象 ${homesTargets.length} 棟、駅コード ${Object.keys(stationCodes).length} 駅、問い合わせ履歴 ${inquiries.length} 件`);
