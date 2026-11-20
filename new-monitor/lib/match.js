// 募集を候補の建物（既存スペースのある建物＝実績ビル）と突き合わせる。
// 仕様メモ「実績ビルの見分け方（改訂）」の 1〜2 と、丁目での絞り込みまで。
// 3 以降（築年月・階数・面積の指紋、他サイト、写真、間取り図）は次の段階で足す。
'use strict';
const { nfkc } = require('./util');

const ROMAN = { 'Ⅰ': '1', 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5', 'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10' };
const KANJI_NUM = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };

// 表記の揺れをそろえる（番号は残す。第一と第二は別の棟）
function normName(s) {
  let t = String(s || '');
  t = t.replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, (m) => ROMAN[m]);
  t = nfkc(t).toLowerCase();
  t = t.replace(/第([一二三四五六七八九十])/g, (m, k) => `第${KANJI_NUM[k]}`);
  t = t.replace(/\b(ii|iii|iv|vi{0,3}|ix|x)\b/g, (m) => ({ ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' }[m] || m));
  t = t.replace(/[\s・･\-‐ー−–—_.,'’"“”()（）「」【】]/g, '');
  t = t.replace(/(マンション|ビルディング|ビル|bldg|building|ハイツ|レジデンス|コーポ|ハウス|ヒルズ)$/g, '');
  t = t.replace(/[ヶケが]/g, 'ケ');
  return t;
}

// 連棟・シリーズの見分け用（番号を外した名前）
function baseName(s) {
  return normName(s).replace(/第?\d+(号館|号棟|棟)?$/, '').replace(/^第?\d+/, '').replace(/(本館|新館|別館|東館|西館|南館|北館|[a-z]棟|[a-z]館)$/, '');
}

// 理由の文に出す呼び名（名前のない建物はスペース名か住所）
const bLabel = (b) => b.name || ((b.spaces || [])[0] || {}).name || b.key;

const townKey = (s) => String(s || '').replace(/[がケヶ]/g, 'ケ');

function sameChome(b, a) {
  return a && b.ward && a.ward === b.ward && townKey(a.town) === townKey(b.town) && (b.chome == null || a.chome == null || a.chome === b.chome);
}

// 返り値: { label: '実績ビル' | '実績ビル？' | '', building, reason, others }
// 入っているのが教室だけの建物は「教室ビル」（レンタルスペースの実績とは分ける）
function matchListing(x, buildings) {
  const r = matchListingRaw(x, buildings);
  if (r.label && r.building && r.building.school) r.label = r.label.replace('実績ビル', '教室ビル');
  return r;
}

function matchListingRaw(x, buildings) {
  const a = x.addr || {};
  const nm = normName(x.name);
  const bn = baseName(x.name);

  if (nm && nm.length >= 2) {
    // 1. 建物名（旧名も）
    for (const b of buildings) {
      if (b.nameIsAddress) continue;
      const names = [b.name, ...(b.aliases || [])];
      if (names.some((n) => normName(n) === nm)) {
        if (sameChome(b, a) || (!a.ward && nm.length >= 4)) return { label: '実績ビル', building: b, reason: '建物名が一致' };
        if (nm.length < 3) continue;
        return { label: '', building: b, reason: `同じ名前の建物が別の場所にある（${b.key}）`, series: true };
      }
    }
    // 連棟（番号違いで同じ丁目）
    if (bn && bn.length >= 3) {
      for (const b of buildings) {
        if (b.nameIsAddress) continue;
        if (baseName(b.name) === bn && normName(b.name) !== nm) {
          if (sameChome(b, a)) return { label: '実績ビル', building: b, reason: `連棟の可能性（スペースが入っているのは「${b.name}」）` };
          return { label: '', building: b, reason: `同じシリーズのビルにスペースあり（${b.name}・${b.key}）`, series: true };
        }
      }
    }
  }

  // 2. 同じ丁目にある実績ビル
  const same = buildings.filter((b) => sameChome(b, a) && a.chome != null);
  if (same.length > 0 && same.length <= 3) {
    // 名前が載っていて、どれとも違うなら別の建物の可能性が高い
    if (nfkc(x.name || '').trim().length >= 2) return { label: '', building: null, reason: `同じ丁目に実績ビルあり（${same.map(bLabel).join('・')}）。名前は違う`, others: same };
    return { label: '実績ビル？', building: same[0], reason: `建物名なし。同じ丁目に実績ビル（${same.map(bLabel).join('・')}）`, others: same };
  }
  if (same.length > 3) {
    return { label: '', building: null, reason: `同じ丁目に実績ビルが${same.length}棟（絞り込みは次の段階）`, others: same.slice(0, 5) };
  }
  return { label: '', building: null, reason: '' };
}

// 問い合わせ履歴との照合。同じ募集（URL）か、同じ建物（名前＋丁目）なら返す
function urlKey(u) {
  const m = String(u || '').match(/(jnc_\d+|bc_\d+|rent_[a-z]+\/\d+|room\/[0-9a-f]+)/);
  return m ? m[1].replace(/^rent_[a-z]+\//, 'athome:') : '';
}
function matchInquiry(x, inquiries) {
  const k = urlKey(x.url);
  const nm = normName(x.name);
  for (const q of inquiries || []) {
    if (k && urlKey(q.url) === k) return { same: 'listing', q };
  }
  for (const q of inquiries || []) {
    const qn = normName(String(q.name || '').replace(/\s*(B?\d+階|B\d+).*$/, ''));
    if (nm && qn && nm.length >= 2 && qn === nm && (!q.addr || !q.addr.ward || sameChome(q.addr, x.addr || {}))) return { same: 'building', q };
  }
  return null;
}

module.exports = { normName, baseName, matchListing, matchInquiry };
