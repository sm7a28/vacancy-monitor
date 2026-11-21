// 物件写真を Claude（Haiku 5.5）に見てもらう。1回の呼び出しで次の2つを判定する。
//  1. ダンススタジオ（レッスン用スタジオ）の居抜きらしいか（2026-11-21 ユーザー「API を使う機能を作る」）
//  2. 外観の銘板・看板から建物名を読み取る → 実績ビルと突き合わせる（仕様メモ「実績ビルの見分け方」の 5。2026-11-21 ユーザー「それも実装して」）
// 費用は Max プランの API 枠だけで使う（クレジットは買わない）。1件あたり写真8枚まで・effort は低めにして安く速く。
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { matchListing, isPlaceholderName } = require('./match');

const MODEL = 'claude-haiku-5-5';
const MAX_IMAGES = 8;
const MAX_BYTES = 3.5 * 1024 * 1024; // 1枚の上限（API は 5MB まで。余裕をみる）

const SYSTEM = [
  'あなたは賃貸の店舗・事務所・マンションの募集写真を見て、次の2つを答える係です。写真に写っているものだけを根拠にし、推測で足さないこと。',
  '',
  '【1】前の入居者がダンススタジオ・ヨガ／バレエ教室などのレッスンスタジオとして使っていた「居抜き」か。',
  '手がかり：壁一面の大きな鏡、レッスン用のバー（バレエバー）、木目のフローリングやリノリウム・ダンスフロアの床材、防音扉・吸音材、天井のスピーカーや照明レール、間仕切りのない広い一室。',
  '鏡が1枚だけ・洗面台の鏡・住宅の洋室のフローリングは手がかりにしない。間取り図や外観だけで内装が写っていない場合は unknown。',
  'maybe にするのは、壁一面の鏡・バー・ダンス用の床材・防音扉や吸音材のどれか1つ以上がはっきり写っているときだけ。木目の床や広い部屋だけなら no。',
  '',
  '【2】建物名。外観・エントランス・郵便受け・銘板・看板などに書かれた建物名（○○ビル、○○マンション、○○ハイツ など）を、写っている文字のとおりに書き写す。',
  '店や会社の看板、不動産会社のロゴ、駅名、通りの名前は建物名ではない。文字が小さく読み切れない・一部しか見えない・途中で切れているときは空にする（途中までの名前は書かない）。',
  '外観で地上の階数が数えられれば floors に入れる（数えられなければ 0）。',
  '',
  '理由・根拠は日本語で短く（40字以内）書く。',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    studio: { type: 'string', enum: ['studio', 'maybe', 'no', 'unknown'], description: 'studio=スタジオの居抜きとほぼ言える／maybe=手がかりが一部ある／no=違う／unknown=内装が写っておらず判断できない' },
    studio_reason: { type: 'string', description: '【1】の根拠。40字以内' },
    building_name: { type: 'string', description: '【2】写真から読み取れた建物名。読めなければ空文字' },
    building_name_where: { type: 'string', description: '建物名が写っていた場所（例：エントランスの銘板）。読めなければ空文字' },
    floors: { type: 'integer', description: '外観で数えた地上階数。数えられなければ 0' },
  },
  required: ['studio', 'studio_reason', 'building_name', 'building_name_where', 'floors'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  return client;
}

async function fetchImage(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || buf.length > MAX_BYTES) return null;
    return { type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

// 1件の物件の写真を見てもらう。{ studio, studioReason, buildingName, buildingNameWhere, floors, images, usage }。写真が取れなければ null
async function analyze(listing) {
  const urls = (listing.images || []).slice(0, MAX_IMAGES);
  const imgs = (await Promise.all(urls.map(fetchImage))).filter(Boolean);
  if (!imgs.length) return null;
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        ...imgs,
        { type: 'text', text: `物件：${listing.kind || ''} ${listing.floor || ''} ${listing.area || ''}㎡\nこの募集写真について【1】【2】を答えてください。` },
      ],
    }],
  });
  const base = { images: imgs.length, usage: res.usage };
  if (res.stop_reason === 'refusal') return { ...base, studio: 'unknown', studioReason: '判定できず（断られた）', buildingName: '', buildingNameWhere: '', floors: 0 };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let o;
  try { o = JSON.parse(text); } catch { return { ...base, studio: 'unknown', studioReason: '判定できず（応答を読めない）', buildingName: '', buildingNameWhere: '', floors: 0 }; }
  return {
    ...base,
    studio: o.studio,
    studioReason: String(o.studio_reason || '').slice(0, 80),
    buildingName: String(o.building_name || '').trim().slice(0, 60),
    buildingNameWhere: String(o.building_name_where || '').trim().slice(0, 40),
    floors: Number.isInteger(o.floors) ? o.floors : 0,
  };
}

// SUUMO が建物名を伏せたときの仮の名前（「京王線 つつじヶ丘駅 2階建 築41年」など）は名前として扱わない
function hasRealName(x) {
  return !isPlaceholderName(x.name);
}

// 写真から読んだ建物名で、候補の建物（実績ビル）と突き合わせ直す
function applyBuildingName(ev, r, buildings, judgeTier) {
  const x = ev.listing;
  const name = r.buildingName;
  if (!name) return null;
  const where = r.buildingNameWhere ? `・${r.buildingNameWhere}` : '';
  ev.judge.tags.push(`写真の建物名：${name}（AI読み取り${where}）`);
  // 募集に名前が載っていて写真の名前と同じなら、照合は済んでいる
  if (hasRealName(x)) return 'same-as-listing';
  const m = matchListing({ ...x, name }, buildings);
  const before = ev.label || '';
  if (m.label && m.building) {
    ev.match = { ...m, reason: `写真の建物名「${name}」：${m.reason}` };
    ev.label = m.label;
    ev.notify = true;
    return before === m.label ? 'confirmed' : 'upgraded';
  }
  if (/^(実績|教室)ビル？$/.test(before)) {
    // 同じ丁目の実績ビルとは名前が違う → 別の建物の可能性が高い
    ev.match = { ...ev.match, label: '', building: null, reason: `写真の建物名「${name}」は同じ丁目の実績ビル（${(ev.match.others || []).map((b) => b.name || b.key).join('・')}）と違う` };
    ev.label = '';
    const tags = ev.judge.tags || [];
    ev.notify = judgeTier !== 'normal' || tags.includes('地下') || tags.includes('1階');
    return 'downgraded';
  }
  return 'no-match';
}

// 物件をまとめて見てもらう（同時に3件まで）。対象：知らせる物件と、同じ丁目に実績ビルがある物件（名前が分かれば実績ビルに上がる）
async function checkEvents(events, buildings, opts = {}) {
  const limit = opts.limit || 60;
  const isTarget = (ev) => ev.type === 'listing' && ev.listing && !ev.duplicateOf && (ev.listing.images || []).length;
  const nearBuilding = (ev) => !ev.label && ev.match && (ev.match.others || []).length > 0 && !hasRealName(ev.listing);
  const first = events.filter((ev) => isTarget(ev) && ev.notify !== false);
  const second = events.filter((ev) => isTarget(ev) && ev.notify === false && nearBuilding(ev));
  const targets = [...first, ...second].slice(0, limit);
  const stat = { tried: targets.length, studio: 0, maybe: 0, no: 0, unknown: 0, named: 0, upgraded: 0, confirmed: 0, downgraded: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const ev = targets[i++];
      try {
        const r = await analyze(ev.listing);
        if (!r) { stat.unknown++; continue; }
        stat.inputTokens += r.usage?.input_tokens || 0;
        stat.outputTokens += r.usage?.output_tokens || 0;
        ev.studio = { verdict: r.studio, reason: r.studioReason };
        ev.photo = { buildingName: r.buildingName, where: r.buildingNameWhere, floors: r.floors };
        stat[r.studio] = (stat[r.studio] || 0) + 1;
        if (r.studio === 'studio' || r.studio === 'maybe') {
          ev.judge.tags.unshift(`${r.studio === 'studio' ? 'スタジオ居抜き' : 'スタジオ居抜きかも'}（写真・AI判定：${r.studioReason}）`);
        }
        if (r.buildingName) {
          stat.named++;
          const res = applyBuildingName(ev, r, buildings || [], ev.judge.tier || 'normal');
          if (res && stat[res] != null) stat[res]++;
        }
      } catch (e) {
        stat.failed++;
        stat.lastError = String(e && (e.status || e.message) || e).slice(0, 120);
        // 認証エラー・枠切れは続けても同じなので止める
        if (e && (e.status === 401 || e.status === 403 || (e.status === 400 && /credit|billing/i.test(String(e.message))))) { stat.stopped = true; i = targets.length; }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return stat;
}

module.exports = { analyze, checkEvents, applyBuildingName, hasRealName, MODEL };
