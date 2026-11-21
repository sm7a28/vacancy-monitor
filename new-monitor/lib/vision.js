// 物件写真から「ダンススタジオ（レッスン用スタジオ）の居抜き」らしいかを Claude（Haiku 5.5）に見てもらう。
// 2026-11-21 ユーザー「API を使う機能を作る」（写真から居抜きを見分ける案）。
// 費用は Max プランの API 枠だけで使う（クレジットは買わない）。1件あたり写真8枚まで・効果は低めにして安く速く。
'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-5-5';
const MAX_IMAGES = 8;
const MAX_BYTES = 3.5 * 1024 * 1024; // 1枚の上限（API は 5MB まで。余裕をみる）

const SYSTEM = [
  'あなたは賃貸の店舗・事務所の募集写真を見て、前の入居者がダンススタジオ・ヨガ／バレエ教室などのレッスンスタジオとして使っていた「居抜き」かどうかを判定する係です。',
  '手がかり：壁一面の大きな鏡、レッスン用のバー（バレエバー）、木目のフローリングやリノリウム・ダンスフロアの床材、防音扉・吸音材、天井のスピーカーや照明レール、間仕切りのない広い一室。',
  '鏡が1枚だけ・洗面台の鏡・住宅の洋室のフローリングは手がかりにしない。間取り図や外観だけで内装が写っていない場合は「判断できない」とする。',
  '写真に写っているものだけを根拠にし、推測で足さない。理由は日本語で短く（40字以内）書く。',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['studio', 'maybe', 'no', 'unknown'], description: 'studio=スタジオの居抜きとほぼ言える／maybe=手がかりが一部ある／no=違う／unknown=内装が写っておらず判断できない' },
    reason: { type: 'string', description: '根拠（写真に写っているもの）。40字以内の日本語' },
  },
  required: ['verdict', 'reason'],
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

// 1件の物件を判定する。{ verdict, reason, images, usage } を返す。写真が取れなければ null
async function checkStudio(listing) {
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
        { type: 'text', text: `物件：${listing.kind || ''} ${listing.floor || ''} ${listing.area || ''}㎡\nこの募集写真は、レッスンスタジオの居抜きですか。` },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') return { verdict: 'unknown', reason: '判定できず（断られた）', images: imgs.length, usage: res.usage };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { return { verdict: 'unknown', reason: '判定できず（応答を読めない）', images: imgs.length, usage: res.usage }; }
  return { verdict: out.verdict, reason: String(out.reason || '').slice(0, 80), images: imgs.length, usage: res.usage };
}

// 知らせる物件をまとめて判定する（同時に3件まで）。結果は ev.studio に入れ、居抜きらしいものは印を付ける
async function checkEvents(events, opts = {}) {
  const limit = opts.limit || 60;
  const targets = events.filter((ev) => ev.type === 'listing' && ev.listing && !ev.duplicateOf && ev.notify !== false && (ev.listing.images || []).length).slice(0, limit);
  const stat = { tried: targets.length, studio: 0, maybe: 0, no: 0, unknown: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const ev = targets[i++];
      try {
        const r = await checkStudio(ev.listing);
        if (!r) { stat.unknown++; continue; }
        ev.studio = { verdict: r.verdict, reason: r.reason };
        stat[r.verdict] = (stat[r.verdict] || 0) + 1;
        stat.inputTokens += r.usage?.input_tokens || 0;
        stat.outputTokens += r.usage?.output_tokens || 0;
        if (r.verdict === 'studio' || r.verdict === 'maybe') {
          ev.judge.tags.unshift(`${r.verdict === 'studio' ? 'スタジオ居抜き' : 'スタジオ居抜きかも'}（写真・AI判定：${r.reason}）`);
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

module.exports = { checkStudio, checkEvents, MODEL };
