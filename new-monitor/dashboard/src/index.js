// 新しい監視のダッシュボード（bukken.sevenart-projects.com）。
// - 巡回の結果を受け取って D1 に保存する（POST /api/ingest、合言葉 NM_DASH_TOKEN）
// - 一覧を見る画面（メールのログインリンクで入る。許可するアドレスは ALLOWED_EMAILS。クッキーの署名は SESSION_SECRET）
//   ログインリンクは Cloudflare Email Routing の送信（send_email）で送る。鍵は要らない
// - 検討／見送りの印（POST /api/status）
// - 定時に GitHub の巡回を起動する（GitHub の定時実行は大きく遅れるため。GH_DISPATCH_TOKEN）
import { EmailMessage } from 'cloudflare:email';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS login_tokens (token TEXT PRIMARY KEY, email TEXT, exp INTEGER)`,
  `CREATE TABLE IF NOT EXISTS login_log (k TEXT, at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, site TEXT, type TEXT, first_seen TEXT, last_event TEXT,
    label TEXT, tier TEXT, notify INTEGER, title TEXT, kind TEXT, address TEXT, stations TEXT,
    rent INTEGER, admin INTEGER, total INTEGER, area REAL, tsubo INTEGER, floor TEXT, madori TEXT,
    tags TEXT, match_reason TEXT, building TEXT, url TEXT, map_url TEXT, salon_url TEXT,
    also_on TEXT, price_drop TEXT, relist INTEGER, status TEXT DEFAULT '', status_at TEXT, text TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_first_seen ON listings(first_seen)`,
  `CREATE TABLE IF NOT EXISTS runs (at TEXT PRIMARY KEY, summary TEXT)`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const s of SCHEMA) await db.prepare(s).run();
  // 後から足した列（あれば何もしない）
  try { await db.prepare('ALTER TABLE listings ADD COLUMN images TEXT').run(); } catch { /* 追加済み */ }
  try { await db.prepare('ALTER TABLE listings ADD COLUMN posted TEXT').run(); } catch { /* 追加済み */ }
  schemaReady = true;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const man = (yen) => (yen ? `${Math.round(yen / 1000) / 10}万` : '-');

// ---- Cloudflare Access の確認 ----
let jwksCache = null;
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function verifyAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const [h, p, sig] = token.split('.');
  if (!sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (!jwksCache) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwksCache = (await r.json()).keys || [];
  }
  const jwk = jwksCache.find((k) => k.kid === header.kid);
  if (!jwk) { jwksCache = null; return null; }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  return ok ? payload.email || 'ok' : null;
}

// ---- 受け取り ----
function row(ev, at) {
  if (ev.type === 'homes') {
    const r = ev.room || {};
    return {
      id: `homes:${r.url}`, site: 'homes', type: 'homes', label: '実績ビル', tier: '', notify: 1,
      title: ev.buildingName, kind: (ev.building && ev.building.kind) || '', address: '', stations: '',
      rent: 0, admin: 0, total: 0, area: parseFloat(r.area) || null, tsubo: 0, floor: r.floor, madori: r.madori,
      tags: JSON.stringify([r.rent, r.admin ? `管理費 ${r.admin}` : ''].filter(Boolean)),
      match_reason: 'HOMES の建物ページに新しい募集', building: JSON.stringify({ name: ev.buildingName, url: ev.buildingUrl, key: ev.buildingKey || '', spaces: ev.spaces || [] }),
      url: r.url, map_url: '', salon_url: '', also_on: '', price_drop: '', relist: 0, text: ev.text || '', images: '[]', posted: '', at,
    };
  }
  const x = ev.listing || {};
  const j = ev.judge || {};
  const m = ev.match || {};
  const slimB = (b) => ({ name: b.name, key: b.key, spaces: (b.spaces || []).slice(0, 5) });
  // 実績ビル（一致した建物）と、同じ丁目にある実績ビル（候補）
  const bInfo = m.building ? { ...slimB(m.building), others: (m.others || []).filter((o) => o.key !== m.building.key).slice(0, 4).map(slimB) }
    : (m.others && m.others.length ? { name: '', key: '', spaces: [], others: m.others.slice(0, 5).map(slimB) } : null);
  return {
    id: x.id, site: x.site, type: 'listing', label: ev.label || '', tier: j.tier || '', notify: ev.notify === false ? 0 : 1,
    title: x.name || x.title || '', kind: x.kind || '', address: x.address || '',
    stations: (x.stations || []).filter((s) => s.station).map((s) => `${s.station}${s.walk != null ? ` ${s.walk}分` : ''}`).join('・'),
    rent: x.rent || 0, admin: x.admin || 0, total: j.total || 0, area: x.area || null, tsubo: j.tsubo || 0,
    floor: x.floor || '', madori: x.madori || '', tags: JSON.stringify(j.tags || []), match_reason: m.reason || '',
    building: bInfo ? JSON.stringify(bInfo) : '',
    url: x.url || '', map_url: ev.mapUrl || '', salon_url: ev.ib ? JSON.stringify(ev.ib) : (ev.salonUrl || ''), also_on: ev.alsoOn || '',
    price_drop: ev.priceDrop ? JSON.stringify(ev.priceDrop) : '', relist: ev.relist ? 1 : 0, text: ev.text || '',
    images: JSON.stringify((x.images || []).filter((u) => /^https:\/\//.test(u)).slice(0, 4)), posted: x.posted || '', at,
  };
}

async function ingest(request, env) {
  if (!env.NM_DASH_TOKEN || request.headers.get('x-nm-token') !== env.NM_DASH_TOKEN) return new Response('forbidden', { status: 403 });
  const body = await request.json();
  const at = (body.summary && body.summary.at) || new Date().toISOString();
  await ensureSchema(env.DB);
  const stmts = [env.DB.prepare('INSERT OR REPLACE INTO runs (at, summary) VALUES (?, ?)').bind(at, JSON.stringify(body.summary || {}))];
  for (const ev of body.events || []) {
    const r = row(ev, at);
    if (!r.id) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO listings (id, site, type, first_seen, last_event, label, tier, notify, title, kind, address, stations, rent, admin, total, area, tsubo, floor, madori, tags, match_reason, building, url, map_url, salon_url, also_on, price_drop, relist, text, images, posted)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)
       ON CONFLICT(id) DO UPDATE SET last_event = ?4, total = ?14, rent = ?12, admin = ?13, price_drop = CASE WHEN ?26 <> '' THEN ?26 ELSE price_drop END,
         relist = MAX(relist, ?27), also_on = CASE WHEN ?25 <> '' THEN ?25 ELSE also_on END, text = ?28,
         images = CASE WHEN ?29 <> '[]' THEN ?29 ELSE images END, building = CASE WHEN ?21 <> '' THEN ?21 ELSE building END`,
    ).bind(r.id, r.site, r.type, at, r.label, r.tier, r.notify, r.title, r.kind, r.address, r.stations, r.rent, r.admin, r.total, r.area, r.tsubo, r.floor, r.madori, r.tags, r.match_reason, r.building, r.url, r.map_url, r.salon_url, r.also_on, r.price_drop, r.relist, r.text, r.images, r.posted));
  }
  const saved = stmts.length - 1;
  // 後の巡回で分かった掲載日（アットホームの情報公開日は1回に1件しか取れないため）
  for (const u of body.updates || []) {
    if (u && u.id && u.posted) stmts.push(env.DB.prepare('UPDATE listings SET posted = ? WHERE id = ?').bind(String(u.posted).slice(0, 80), u.id));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return Response.json({ ok: true, saved, updated: (body.updates || []).length });
}

// ---- 画面 ----
const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1f2328;--sub:#5b6370;--line:#e3e1dc;--accent:#b4532a;--gold:#9a6b00;--blue:#2459a8;--green:#2f7a45;--muted:#8a8f98}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--card:#1f2228;--ink:#e8e6e1;--sub:#a3a9b3;--line:#30343b;--accent:#e08a5c;--gold:#d9a93a;--blue:#7aa7ec;--green:#6fc28a;--muted:#7c828c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px}
h1{font-size:17px;margin:0 0 6px}main{max-width:980px;margin:0 auto;padding:12px 16px 60px}
form.f{display:flex;flex-wrap:wrap;gap:6px;align-items:center}form.f select,form.f input{font:inherit;font-size:14px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
.health{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px;font-size:12.5px;color:var(--sub)}.health span{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:2px 9px}.health .bad{color:var(--accent);border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.card.dim{opacity:.55}.top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.lb{font-size:12px;font-weight:700;border-radius:4px;padding:1px 7px;color:#fff;background:var(--muted)}.lb.j{background:var(--accent)}.lb.q{background:var(--gold)}.lb.p{background:var(--blue)}.lb.f{background:var(--green)}
.t{font-weight:700;font-size:16px}.meta{color:var(--sub);font-size:13.5px}.price{font-weight:700}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}.tags span{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:0 6px;color:var(--sub)}
.links{display:flex;flex-wrap:wrap;gap:10px;font-size:13.5px;margin-top:4px}.links a{color:var(--blue)}
.st{display:flex;gap:6px;margin-top:8px}.st button{font:inherit;font-size:13px;padding:3px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}.st button.on{background:var(--ink);color:var(--bg)}
.reason{font-size:13px;color:var(--gold);margin-top:2px}.empty{color:var(--sub);padding:30px 0;text-align:center}
.row{display:flex;gap:12px}.body{flex:1;min-width:0}
.thumbs{flex:0 0 132px;display:grid;grid-template-columns:1fr 1fr;gap:3px;align-content:start}
.thumbs a:first-child{grid-column:1/3}.thumbs img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:6px;background:var(--line);display:block}
.thumbs.none{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;height:auto;background:var(--bg);border:1px dashed var(--line);border-radius:6px;color:var(--muted);font-size:12px}
.site{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;border-radius:4px;padding:1px 7px 1px 4px;color:#fff}
.site img{width:14px;height:14px;border-radius:3px;background:#fff}
.site.suumo{background:#4f9a1f}.site.athome{background:#e8730c}.site.homes{background:#c8312b}
.jis{margin-top:6px;border-left:3px solid var(--accent);padding:4px 10px;background:var(--bg);border-radius:0 6px 6px 0;font-size:13.5px}
.jis .h{font-weight:700}.jis a{color:var(--blue)}.jis .sp{display:block;margin-left:1em}
@media (max-width:560px){.row{flex-direction:column}.thumbs{flex:none;grid-template-columns:repeat(4,1fr);width:100%}.thumbs a:first-child{grid-column:auto}}
`;
const SITE = { suumo: ['SUUMO', 'suumo.jp'], athome: ['アットホーム', 'athome.co.jp'], homes: ["HOME'S", 'homes.co.jp'] };
const siteBadge = (s) => {
  const [n, d] = SITE[s] || [s, ''];
  return `<span class="site ${esc(s)}">${d ? `<img src="https://www.google.com/s2/favicons?domain=${d}&sz=32" alt="" loading="lazy">` : ''}${esc(n)}</span>`;
};
const gmap = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
// 実績ビルの場所（建物名・住所・入っているスペース）
function jissekiBlock(b, label) {
  if (!b) return '';
  const one = (x, head) => {
    const addr = String(x.key || '').replace(/^東京都|^神奈川県/, '');
    const nm = x.name || '（建物名なし）';
    // URL が分からないスペースは、名前と住所の Google 検索に飛ばす（2026-11-20）
    const sUrl = (s) => s.url || `https://www.google.com/search?q=${encodeURIComponent(`${s.name} ${x.address || x.key || ''}`.trim())}`;
    const sp = (x.spaces || []).map((s) => `<a class="sp" href="${esc(sUrl(s))}" target="_blank" rel="noopener">${esc(s.source || '')}：${esc(s.name)}${s.url ? '' : '（URL不明・検索）'}</a>`).join('');
    return `<div><span class="h">${head}</span> ${esc(nm)}${addr ? `　<a href="${esc(gmap(x.key + (x.name ? ' ' + x.name : '')))}" target="_blank" rel="noopener">${esc(addr)}</a>` : ''}${x.url ? `　<a href="${esc(x.url)}" target="_blank" rel="noopener">HOMES の建物ページ</a>` : ''}${sp}</div>`;
  };
  const parts = [];
  if (b.name || b.key || (b.spaces || []).length) parts.push(one(b, label === '実績ビル？' ? '実績ビル（候補）：' : label === '教室ビル？' ? '教室ビル（候補）：' : label === '教室ビル' ? '教室ビル（教室が入っている建物）：' : label ? '実績ビル：' : '同じ名前・シリーズの実績ビル：'));
  for (const o of b.others || []) parts.push(one(o, '同じ丁目の実績ビル：'));
  return parts.length ? `<div class="jis">${parts.join('')}</div>` : '';
}

function labelBadge(r) {
  if (r.label === '実績ビル') return '<span class="lb j">実績ビル</span>';
  if (r.label === '実績ビル？') return '<span class="lb q">実績ビル？</span>';
  if (r.label === '教室ビル') return '<span class="lb j">教室ビル</span>';
  if (r.label === '教室ビル？') return '<span class="lb q">教室ビル？</span>';
  if (r.tier === 'pinpoint') return '<span class="lb p">一等地</span>';
  if (r.tier === 'focus') return '<span class="lb f">重点</span>';
  return '<span class="lb">向いてる物件</span>';
}

function card(r) {
  const tags = (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })();
  const b = (() => { try { return r.building ? JSON.parse(r.building) : null; } catch { return null; } })();
  const drop = (() => { try { return r.price_drop ? JSON.parse(r.price_drop) : null; } catch { return null; } })();
  const links = [`<a href="${esc(r.url)}" target="_blank" rel="noopener">物件ページ</a>`];
  if (r.map_url) links.push(`<a href="${esc(r.map_url)}" target="_blank" rel="noopener">地図</a>`);
  // インスタベースの駅の検索（物件に合いそうな業態を先頭に。ほかの業態も並べる）
  const ib = (() => { try { return String(r.salon_url || '').startsWith('{') ? JSON.parse(r.salon_url) : null; } catch { return null; } })();
  if (ib) {
    const names = { salon: 'サロン', party: 'パーティー', kaigishitsu: '会議室', dance: 'ダンス' };
    links.push(`<a href="${esc(ib.url)}" target="_blank" rel="noopener"><b>インスタベース ${esc(ib.station)}駅・${esc(names[ib.genre] || '')}</b></a>`);
    for (const [g, u] of Object.entries(ib.all || {})) if (g !== ib.genre) links.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(names[g] || g)}</a>`);
  } else if (r.salon_url) links.push(`<a href="${esc(r.salon_url)}" target="_blank" rel="noopener">駅のサロン検索</a>`);
  if (r.also_on) links.push(`<a href="${esc(r.also_on)}" target="_blank" rel="noopener">別サイトの掲載</a>`);
  const imgs = (() => { try { return JSON.parse(r.images || '[]').filter((u) => /^https:\/\//.test(u)); } catch { return []; } })();
  const thumbs = imgs.length
    ? `<div class="thumbs">${imgs.slice(0, 3).map((u) => `<a href="${esc(r.url)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>`
    : '<div class="thumbs none">写真なし</div>';
  const price = r.type === 'homes' ? '' : `<span class="price">${man(r.total)}</span>（${man(r.rent)}＋${man(r.admin)}）／${r.area ?? '-'}㎡／坪${man(r.tsubo)}`;
  const st = (v, txt) => `<button class="${r.status === v ? 'on' : ''}" data-id="${esc(r.id)}" data-v="${v}">${txt}</button>`;
  return `<div class="card${r.status === 'skip' ? ' dim' : ''}"><div class="row">${thumbs}<div class="body">
    <div class="top">${siteBadge(r.site)}${labelBadge(r)}<span class="t">${esc(r.title || r.kind || '（建物名なし）')}</span></div>
    <div class="meta">掲載 ${esc(r.posted || '不明')}　見つけた ${esc(String(r.first_seen || '').slice(5).replace('-', '/'))}</div>
    <div class="meta">${esc(r.kind)} ${esc(r.address)} ${esc(r.stations)}</div>
    <div>${price} ${esc(r.floor || '')} ${esc(r.madori || '')}</div>
    ${r.match_reason ? `<div class="reason">${esc(r.match_reason)}</div>` : ''}
    ${jissekiBlock(b, r.label)}
    ${drop ? `<div class="reason">値下げ ${man(drop.from)} → ${man(drop.to)}</div>` : ''}${r.relist ? '<div class="reason">再掲</div>' : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="links">${links.join('')}</div>
    <div class="st">${st('consider', '検討する')}${st('skip', '見送り')}${st('', '印なし')}</div>
  </div></div></div>`;
}

function healthLine(summary) {
  if (!summary) return '<span class="bad">巡回の記録がまだありません</span>';
  const parts = [`<span>最後の巡回 ${esc(summary.at)}</span>`];
  for (const [k, v] of Object.entries(summary.sources || {})) {
    const bad = v.error || v.blocked || v.mayHaveGap || (v.failed && v.failed > 5);
    if (k === 'athomeDetail') { parts.push(`<span>アットホーム公開日 ${v.ok ? '1件取得' : '-'}（待ち${v.queued ?? 0}）</span>`); continue; }
    if (k === 'suumoDetail') { parts.push(`<span class="${v.failed > v.ok ? 'bad' : ''}">SUUMO 更新日 ${v.ok}/${v.tried}</span>`); continue; }
    const n = k.startsWith('homes') ? `${v.ok}/${v.buildings}棟` : `新着${v.fresh ?? 0}`;
    const extra = v.blocked ? ' 認証画面' : v.mayHaveGap ? ' 取りこぼし?' : v.error ? ' エラー' : '';
    parts.push(`<span class="${bad ? 'bad' : ''}">${esc(k)} ${n}${extra}</span>`);
  }
  return parts.join('');
}

async function page(request, env, who) {
  await ensureSchema(env.DB);
  const u = new URL(request.url);
  const q = Object.fromEntries(u.searchParams);
  const days = Math.min(parseInt(q.days || '7', 10) || 7, 90);
  const where = ["first_seen >= ?"];
  const since = new Date(Date.now() + 9 * 3600e3 - days * 86400e3).toISOString().replace('T', ' ').slice(0, 16);
  const args = [since];
  const show = q.show || 'notify';
  if (show === 'notify') where.push('notify = 1');
  if (show === 'jisseki') where.push("label <> ''");
  if (q.tier) { where.push('tier = ?'); args.push(q.tier); }
  if (q.site) { where.push('site = ?'); args.push(q.site); }
  if (q.status === 'none') where.push("status = ''");
  else if (q.status) { where.push('status = ?'); args.push(q.status); }
  if (q.q) { where.push('(title LIKE ? OR address LIKE ? OR stations LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = (await env.DB.prepare(`SELECT * FROM listings WHERE ${where.join(' AND ')} ORDER BY (label <> '') DESC, first_seen DESC LIMIT 300`).bind(...args).all()).results;
  const last = await env.DB.prepare('SELECT summary FROM runs ORDER BY at DESC LIMIT 1').first();
  const summary = last ? JSON.parse(last.summary) : null;
  const sel = (name, opts) => `<select name="${name}">${opts.map(([v, t]) => `<option value="${v}"${(q[name] || (name === 'show' ? 'notify' : name === 'days' ? '7' : '')) === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>物件監視</title>${iconLinks(request.nmBase || "")}<style>${CSS}</style></head><body>
<header><h1>物件監視</h1>
<form class="f" method="get">
${sel('show', [['notify', '知らせる対象'], ['jisseki', '実績ビルだけ'], ['all', '記録のみも全部']])}
${sel('tier', [['', '地域：全部'], ['pinpoint', 'ピンポイント'], ['focus', '重点'], ['normal', 'ふつう']])}
${sel('site', [['', 'サイト：全部'], ['suumo', 'SUUMO'], ['athome', 'アットホーム'], ['homes', 'HOMES']])}
${sel('status', [['', '印：全部'], ['none', '印なし'], ['consider', '検討する'], ['skip', '見送り']])}
${sel('days', [['1', '今日'], ['3', '3日'], ['7', '7日'], ['30', '30日'], ['90', '90日']])}
<input name="q" placeholder="駅・住所・名前" value="${esc(q.q || '')}" size="10"><button>絞り込む</button></form>
<div class="health">${healthLine(summary)}</div></header>
<main>${rows.length ? rows.map(card).join('') : '<div class="empty">該当する物件はありません</div>'}</main>
<script>
const BASE = ${JSON.stringify(request.nmBase || '')};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.st button'); if (!b) return;
  const r = await fetch(BASE + '/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id, status: b.dataset.v }) });
  if (r.ok) { b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b && b.dataset.v !== '')); b.closest('.card').classList.toggle('dim', b.dataset.v === 'skip'); }
});
</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

async function setStatus(request, env) {
  const { id, status } = await request.json();
  if (!['', 'consider', 'skip'].includes(status)) return new Response('bad', { status: 400 });
  await env.DB.prepare('UPDATE listings SET status = ?, status_at = ? WHERE id = ?').bind(status, new Date().toISOString(), id).run();
  return Response.json({ ok: true });
}

// ---- 定時に GitHub の巡回を起動 ----
async function dispatch(env) {
  if (!env.GH_DISPATCH_TOKEN) return { ok: false, reason: 'no token' };
  const r = await fetch('https://api.github.com/repos/sm7a28/vacancy-monitor/actions/workflows/new-monitor.yml/dispatches', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'nm-dashboard', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main' }),
  });
  return { ok: r.status === 204, status: r.status };
}

// ---- メールのログインリンク ----
const COOKIE = 'nm_session';
const SESSION_DAYS = 30;
const allowed = (env) => String(env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
async function sessionUser(request, env) {
  if (!env.SESSION_SECRET) return null;
  const c = (request.headers.get('cookie') || '').split(/;\s*/).find((x) => x.startsWith(`${COOKIE}=`));
  if (!c) return null;
  const [email, exp, sig] = decodeURIComponent(c.slice(COOKIE.length + 1)).split('|');
  if (!email || !exp || !sig || parseInt(exp, 10) < Date.now() / 1000) return null;
  if (sig !== (await hmac(env.SESSION_SECRET, `${email}|${exp}`))) return null;
  return allowed(env).includes(email) ? email : null;
}
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
async function sendLoginMail(env, to, link) {
  const from = env.MAIL_FROM || 'noreply@sevenart-projects.com';
  const body = `物件監視のダッシュボードにログインするリンクです（15分有効・1回限り）。\n\n${link}\n\n心当たりがない場合は、このメールを無視してください。\n`;
  const raw = [
    `From: =?UTF-8?B?${b64('物件監視')}?= <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64('【物件監視】ログインリンク')}?=`,
    `Message-ID: <${crypto.randomUUID()}@sevenart-projects.com>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
  await env.MAIL.send(new EmailMessage(from, to, raw));
}
function loginHtml(msg) {
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>物件監視</title>${iconLinks("")}<style>${CSS}.box{max-width:380px;margin:60px auto;padding:0 16px}.box input,.box button{font:inherit;width:100%;padding:8px;margin-top:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}.box button{background:var(--ink);color:var(--bg);cursor:pointer}</style></head><body><div class="box"><h1>物件監視</h1>${msg ? `<p>${esc(msg)}</p>` : ''}<form method="post" action="/login"><input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required><button>ログインリンクを送る</button></form></div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' } });
}
async function postLogin(request, env) {
  await ensureSchema(env.DB);
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const ip = request.headers.get('cf-connecting-ip') || '';
  const now = Math.floor(Date.now() / 1000);
  // 送りすぎを防ぐ：同じアドレスは1分に1回、同じ接続元は1時間に10回まで
  const recentEmail = await env.DB.prepare('SELECT COUNT(*) n FROM login_log WHERE k = ? AND at > ?').bind(`e:${email}`, now - 60).first();
  const recentIp = await env.DB.prepare('SELECT COUNT(*) n FROM login_log WHERE k = ? AND at > ?').bind(`i:${ip}`, now - 3600).first();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_log (k, at) VALUES (?, ?)').bind(`e:${email}`, now),
    env.DB.prepare('INSERT INTO login_log (k, at) VALUES (?, ?)').bind(`i:${ip}`, now),
    env.DB.prepare('DELETE FROM login_log WHERE at < ?').bind(now - 86400),
    env.DB.prepare('DELETE FROM login_tokens WHERE exp < ?').bind(now),
  ]);
  const generic = '登録済みのアドレスなら、ログインリンクを送りました。メールを確認してください（15分有効）。';
  if ((recentEmail && recentEmail.n > 0) || (recentIp && recentIp.n >= 10)) return loginHtml('少し時間をおいてから試してください。');
  if (!allowed(env).includes(email)) return loginHtml(generic);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO login_tokens (token, email, exp) VALUES (?, ?, ?)').bind(token, email, now + 900).run();
  try {
    await sendLoginMail(env, email, `${new URL(request.url).origin}/auth?t=${token}`);
  } catch (e) {
    return loginHtml(`メールを送れませんでした（${String(e).slice(0, 120)}）`);
  }
  return loginHtml(generic);
}
async function auth(request, env) {
  await ensureSchema(env.DB);
  const t = new URL(request.url).searchParams.get('t') || '';
  if (!/^[0-9a-f]{64}$/.test(t)) return loginHtml('リンクが正しくありません。');
  const row = await env.DB.prepare('SELECT email, exp FROM login_tokens WHERE token = ?').bind(t).first();
  await env.DB.prepare('DELETE FROM login_tokens WHERE token = ?').bind(t).run();
  if (!row || row.exp < Date.now() / 1000 || !allowed(env).includes(row.email)) return loginHtml('リンクの期限が切れているか、使用済みです。もう一度送ってください。');
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const val = `${row.email}|${exp}|${await hmac(env.SESSION_SECRET, `${row.email}|${exp}`)}`;
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=${encodeURIComponent(val)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
}

// ファビコン（2026-11-21 ユーザー「管理画面にファビコン設定しておいて」）。建物＋虫めがね。ログイン前でも返す
const FAVICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#1c7ed6\"/><rect x=\"12\" y=\"12\" width=\"26\" height=\"40\" rx=\"2\" fill=\"#fff\"/><g fill=\"#1c7ed6\"><rect x=\"17\" y=\"18\" width=\"6\" height=\"6\"/><rect x=\"27\" y=\"18\" width=\"6\" height=\"6\"/><rect x=\"17\" y=\"28\" width=\"6\" height=\"6\"/><rect x=\"27\" y=\"28\" width=\"6\" height=\"6\"/><rect x=\"17\" y=\"38\" width=\"6\" height=\"6\"/></g><circle cx=\"41\" cy=\"39\" r=\"10\" fill=\"#1c7ed6\" stroke=\"#ffd43b\" stroke-width=\"5\"/><path d=\"M48.5 46.5 L56 54\" stroke=\"#ffd43b\" stroke-width=\"7\" stroke-linecap=\"round\"/></svg>";
const FAVICON_32 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJ4SURBVFhH7Vc9aBRBFN7S0lLZlRNsxM4ukBRXWGjhH0S4RhALKwvTiMGbXf9ICHImaCSFhCAGJRIQIagEdTGIETGGxN1Z0eLAFOIhSFBRQfLkG71h8+Yue7ndOyx88EGYt+9937z3Zi5jWcycYnjAcaN+x5W+40rKCL7jhoNbisGRnFfewDmV5bxgk+3K+zWCs4WQ0WZvcTsjj7baQn42Pm4RbBF+tz3ZoQVkXO7GIGSk2uEUZcFwtgm2CE5h9yPc0S5g5ixHyHnuAJoxniMJmDtUwHAAzRjP0Qj+fQGlxxW9hr/rrf0X0DIB6zGeoxFkJ+BbQL3XR+jSxACdGb9Mh67cMXLWQqKAWuWOrw37ZaL3vURBp4G5mcOUv/jIyB1HKgE7+57T8uJBgziOHwt52jc0ZeTPRMCD6eOayH94jDoGZrSw4ckL2vdutpu2nV0wOBoSUNe+vtIEEMLjgf6bJf0N5oP70wn4NKGTY8c8vorKyz3qm9tTJw0fkCigVguULXkqMQh4bBxoTbUN3Ac0L+DjqK5Avf4CwdPCmm1qXsDyEy0A557HA32xGcD9wP1AooC6tvKT6G23So6j1jN2bVX8ufEhTb7yuot2laYNjnQCYLGTAKDcKPUz/+iq9apvx/k5gyedABha8WavQah2HnQlirAcEZY5+boEwH59IarcUBOPU4EK4CIqXJ2kpRf764rAv+eW7Ya3OHmWwO3IRUCc8otw1rKFPMGDsgYXcfdez19fOGjlvPmNtpAfeFDWgAjchhhS/EKi/HiRqZeR7UV5HtBq4KEaex1alnM62N2OSmDnBnnV0A70BcPBA1PjzwNojL+MfwNL1bYB6m/WSQAAAABJRU5ErkJggg==";
const APPLE_ICON = "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";
function pngResponse(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Response(buf, { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } });
}
function iconResponse(pathname) {
  if (pathname === "/favicon.svg") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } });
  if (pathname === "/favicon-32.png" || pathname === "/favicon.ico") return pngResponse(FAVICON_32);
  if (pathname === "/apple-touch-icon.png" || pathname === "/apple-touch-icon-precomposed.png") return pngResponse(APPLE_ICON);
  return null;
}
const iconLinks = (base) => `<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml"><link rel="icon" href="${base}/favicon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">`;

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const icon = iconResponse(u.pathname);
    if (icon) return icon;
    if (u.pathname === '/api/ingest' && request.method === 'POST') return ingest(request, env);
    // 巡回を今すぐ起動する（合言葉 NM_DASH_TOKEN が要る。定時の起動の確認用）
    if (u.pathname === '/api/dispatch' && request.method === 'POST') {
      if (!env.NM_DASH_TOKEN || request.headers.get('x-nm-token') !== env.NM_DASH_TOKEN) return new Response('forbidden', { status: 403 });
      return Response.json(await dispatch(env));
    }
    if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
    if (u.pathname === '/login' && request.method === 'POST') return postLogin(request, env);
    if (u.pathname === '/auth') return auth(request, env);
    if (u.pathname === '/logout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    // admin.sevenart-projects.com（パスワード確認済み）からの中継
    const internal = !!env.INTERNAL_KEY && request.headers.get('x-nm-internal') === env.INTERNAL_KEY;
    const baseHdr = request.headers.get('x-nm-base') || '';
    request.nmBase = internal && /^\/[a-z]+$/.test(baseHdr) ? baseHdr : '';
    const who = (internal ? 'admin' : null) || (await sessionUser(request, env)) || (await verifyAccess(request, env));
    if (!who) return loginHtml('');
    if (u.pathname === '/api/status' && request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (!internal && origin && new URL(origin).host !== u.host) return new Response('forbidden', { status: 403 });
      return setStatus(request, env);
    }
    if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
    if (u.pathname === '/') return page(request, env, who);
    return new Response('not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};
