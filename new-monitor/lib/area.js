// 地域と家賃の判定（outputs/監視の作り直し_仕様メモ.md の決定をそのまま書いたもの）。
'use strict';
const { nfkc } = require('./util');

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

// ピンポイント（坪2.5万円くらい・家賃は17万円まで機械で残す）
const PINPOINT = set(`
  銀座 銀座一丁目 東銀座 有楽町 京橋 東京 大手町 二重橋前 日比谷
  秋葉原 神田 御茶ノ水 新御茶ノ水 岩本町 淡路町 小川町 末広町 湯島
  上野 御徒町 上野御徒町 上野広小路 仲御徒町 新御徒町
  赤坂 赤坂見附 乃木坂 六本木 六本木一丁目 麻布十番
  表参道 青山一丁目 外苑前 広尾 白金台 白金高輪 恵比寿 代官山
  中目黒 神楽坂 牛込神楽坂 築地 築地市場 日本橋 人形町
  虎ノ門 虎ノ門ヒルズ 新橋 内幸町 四ツ谷 四谷 麹町 半蔵門
`);
// 渋谷・新宿・池袋は駅徒歩3分以内だけピンポイント
const PINPOINT_NEAR = set('渋谷 新宿 池袋');
// ド鉄板（ピンポイントの中でも一番目立たせる）
const DOTEPPAN = set('上野 御徒町 上野御徒町 上野広小路 仲御徒町 秋葉原 御茶ノ水 新御茶ノ水 神田 岩本町 淡路町 小川町 末広町 湯島');
// 重点エリア（坪では切らず家賃17万円まで機械で残す。サロン11万・スタジオ15万くらいが目安）
// 京王線の重点は5駅だけ（2026-11-21 ユーザー「重点はこれくらいだ」「調布もだ」：明大前・千歳烏山・調布・府中・聖蹟桜ヶ丘）。
// 前は「など全部」を京王線の全駅と広げていて、中河原・飛田給・平山城址公園・長沼まで重点になっていた（誤り）
const FOCUS = set(`
  浅草 蔵前 月島 勝どき 水天宮前 八丁堀
  二子玉川 三軒茶屋 駒沢大学 桜新町 用賀 成城学園前 代々木上原 代々木八幡 初台
  池尻大橋 駒場東大前 自由が丘 都立大学 学芸大学 祐天寺 田園調布 多摩川 新丸子 武蔵小杉
  明大前 千歳烏山 調布 府中 聖蹟桜ケ丘
  市が尾 藤が丘 センター北
`);
const KEIO_SUBURB = set('仙川 つつじケ丘 柴崎 国領 布田 調布 西調布 飛田給 武蔵野台 多磨霊園 東府中 府中 分倍河原 中河原 聖蹟桜ケ丘 百草園 高幡不動 南平 平山城址公園 長沼 北野 京王八王子');
const STUDIO_STRONG = set('立川 三鷹 府中 調布');
const SALON_STRONG = set('国分寺');
const SHINJUKU_CAUTION = set('新宿 新宿三丁目 西新宿 東新宿 西武新宿 新大久保 新宿西口 都庁前 西新宿五丁目');
// 隅田川と荒川の間で「知らせる」駅
const EAST_OK = set('押上 錦糸町 亀戸 両国 門前仲町 清澄白河 森下 北千住 豊洲');
// 神奈川で範囲に入れる駅（南武線 川崎〜武蔵溝ノ口、東横線 新丸子、市が尾・藤が丘・センター北）
const KANAGAWA_OK = set('川崎 尻手 矢向 鹿島田 平間 向河原 武蔵小杉 武蔵中原 武蔵新城 武蔵溝ノ口 溝の口 新丸子 市が尾 藤が丘 センター北');
const EXCLUDED_STATIONS = set('橋本 南大沢');
const EXCLUDED_WARDS = set('葛飾区 江戸川区');
const EAST_WARDS = set('墨田区 江東区 足立区');

function normStation(s) {
  return nfkc(s).replace(/駅$/, '').replace(/ヶ/g, 'ケ').trim();
}

function has(setObj, st) {
  if (setObj.has(st)) return true;
  // 「つつじケ丘」「つつじヶ丘」などの揺れ
  const alt = st.replace(/ケ/g, 'が');
  return setObj.has(alt) || setObj.has(st.replace(/が/g, 'ケ'));
}

const TSUBO = 3.30579;

// x: { addr:{ward}, address, stations:[{station,walk}], rent, admin, area, floor }
function judge(x) {
  const reasons = [];
  const tags = [];
  const pref = x.pref || (/神奈川|川崎市|横浜市/.test(nfkc(x.address || '') + (x.addr && x.addr.ward)) ? 'kanagawa' : 'tokyo');
  const ward = (x.addr && x.addr.ward) || '';
  const sts = (x.stations || []).filter((s) => s.station && s.walk != null).map((s) => ({ ...s, station: normStation(s.station) }));
  const near = sts.filter((s) => s.walk <= 10);
  const total = (x.rent || 0) + (x.admin || 0);
  const tsubo = x.area > 0 ? total / (x.area / TSUBO) : NaN;
  const base = { total, tsubo: Math.round(tsubo), tier: '', tags, reasons };

  if (!(x.area >= 10)) return { ...base, pass: false, reasons: [`広さ${x.area}㎡`] };
  if (!(x.rent > 1000)) return { ...base, pass: false, reasons: ['家賃が載っていない'] };
  if (near.length === 0) return { ...base, pass: false, reasons: ['駅徒歩10分以内なし'] };
  if (EXCLUDED_WARDS.has(ward)) return { ...base, pass: false, reasons: ['荒川より東'] };
  if (near.some((s) => has(EXCLUDED_STATIONS, s.station)) && !near.some((s) => !has(EXCLUDED_STATIONS, s.station))) {
    return { ...base, pass: false, reasons: ['除外の駅'] };
  }
  if (pref === 'kanagawa' && !near.some((s) => has(KANAGAWA_OK, s.station))) {
    return { ...base, pass: false, reasons: ['神奈川の範囲外の駅'] };
  }
  if (ward === '足立区' && !near.some((s) => has(EAST_OK, s.station))) {
    return { ...base, pass: false, reasons: ['荒川より東（足立区）'] };
  }

  // 一番条件のよい駅で段階を決める
  let tier = 'normal';
  for (const s of near) {
    if (has(PINPOINT, s.station) || (has(PINPOINT_NEAR, s.station) && s.walk <= 3)) { tier = 'pinpoint'; break; }
  }
  if (tier === 'normal' && near.some((s) => has(FOCUS, s.station))) tier = 'focus';
  if (near.some((s) => has(DOTEPPAN, s.station))) tags.push('ド鉄板');

  let pass;
  // 坪単価：ピンポイントだけ2.5万円まで広げる。重点はふつうと同じ1.5万円で、違いは「全部知らせる」ことだけ
  // （仕様メモ 2026-11-18 訂正「坪2.5万円まで広げるのは、もっとピンポイント。それ以外の重点エリアは坪1.5万円以下のまま、通知で目立たせるだけ」。
  //   前はピンポイント・重点とも坪3万円にしていた（誤り）。2026-11-21 ユーザー「これが坪3万とかバカなのか」）
  if (tier === 'pinpoint') pass = total <= 170000 && tsubo <= 25000;
  else if (tier === 'focus') pass = total <= 170000 && tsubo <= 15000;
  else pass = tsubo <= 15000 && total <= 170000; // 上限は全部17万円（2026-11-21 ユーザー「17万だろ全部」。前は20万円で、ふつうの地域のほうが高かった）
  if (!pass) reasons.push(`家賃${Math.round(total / 1000) / 10}万・坪${Math.round(tsubo / 100) / 100}万（${tier}）`);

  if (EAST_WARDS.has(ward) && !near.some((s) => has(EAST_OK, s.station))) tags.push('隅田川の東');
  if (tier !== 'normal' && total > 150000) tags.push('少し高め');
  if (near.some((s) => has(KEIO_SUBURB, s.station)) && total > 100000) tags.push('少し高め（京王線の郊外）');
  if (near.some((s) => has(STUDIO_STRONG, s.station))) tags.push('スタジオ向き強め');
  if (near.some((s) => has(SALON_STRONG, s.station))) tags.push('サロン向き強め');
  if (near.some((s) => has(SHINJUKU_CAUTION, s.station))) tags.push('サロンは客層に注意');
  const fl = nfkc(x.floor || '');
  if (/^(B|地下)/i.test(fl)) tags.push('地下');
  else if (/^1階/.test(fl)) tags.push('1階');
  if (x.area < 15) tags.push('狭い（15㎡未満）');
  const minWalk = Math.min(...near.map((s) => s.walk));
  if (minWalk >= 5) tags.push(near.length >= 2 ? `駅と駅の中間（どの駅からも5分以上）` : `駅から${minWalk}分`);

  return { ...base, tier, pass, tags: [...new Set(tags)], reasons };
}

module.exports = { judge, normStation };
