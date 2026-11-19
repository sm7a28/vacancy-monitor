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
      match_reason: 'HOMES の建物ページに新しい募集', building: JSON.stringify({ name: ev.buildingName, url: ev.buildingUrl }),
      url: r.url, map_url: '', salon_url: '', also_on: '', price_drop: '', relist: 0, text: ev.text || '', at,
    };
  }
  const x = ev.listing || {};
  const j = ev.judge || {};
  const m = ev.match || {};
  return {
    id: x.id, site: x.site, type: 'listing', label: ev.label || '', tier: j.tier || '', notify: ev.notify === false ? 0 : 1,
    title: x.name || x.title || '', kind: x.kind || '', address: x.address || '',
    stations: (x.stations || []).filter((s) => s.station).map((s) => `${s.station}${s.walk != null ? ` ${s.walk}分` : ''}`).join('・'),
    rent: x.rent || 0, admin: x.admin || 0, total: j.total || 0, area: x.area || null, tsubo: j.tsubo || 0,
    floor: x.floor || '', madori: x.madori || '', tags: JSON.stringify(j.tags || []), match_reason: m.reason || '',
    building: m.building ? JSON.stringify({ name: m.building.name, key: m.building.key, spaces: (m.building.spaces || []).slice(0, 5) }) : '',
    url: x.url || '', map_url: ev.mapUrl || '', salon_url: ev.salonUrl || '', also_on: ev.alsoOn || '',
    price_drop: ev.priceDrop ? JSON.stringify(ev.priceDrop) : '', relist: ev.relist ? 1 : 0, text: ev.text || '', at,
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
      `INSERT INTO listings (id, site, type, first_seen, last_event, label, tier, notify, title, kind, address, stations, rent, admin, total, area, tsubo, floor, madori, tags, match_reason, building, url, map_url, salon_url, also_on, price_drop, relist, text)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)
       ON CONFLICT(id) DO UPDATE SET last_event = ?4, total = ?14, rent = ?12, admin = ?13, price_drop = CASE WHEN ?26 <> '' THEN ?26 ELSE price_drop END,
         relist = MAX(relist, ?27), also_on = CASE WHEN ?25 <> '' THEN ?25 ELSE also_on END, text = ?28`,
    ).bind(r.id, r.site, r.type, at, r.label, r.tier, r.notify, r.title, r.kind, r.address, r.stations, r.rent, r.admin, r.total, r.area, r.tsubo, r.floor, r.madori, r.tags, r.match_reason, r.building, r.url, r.map_url, r.salon_url, r.also_on, r.price_drop, r.relist, r.text));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return Response.json({ ok: true, saved: stmts.length - 1 });
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
`;

function labelBadge(r) {
  if (r.label === '実績ビル') return '<span class="lb j">実績ビル</span>';
  if (r.label === '実績ビル？') return '<span class="lb q">実績ビル？</span>';
  if (r.tier === 'pinpoint') return '<span class="lb p">ピンポイント</span>';
  if (r.tier === 'focus') return '<span class="lb f">重点</span>';
  return '<span class="lb">向いてる物件</span>';
}

function card(r) {
  const tags = (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })();
  const b = (() => { try { return r.building ? JSON.parse(r.building) : null; } catch { return null; } })();
  const drop = (() => { try { return r.price_drop ? JSON.parse(r.price_drop) : null; } catch { return null; } })();
  const links = [`<a href="${esc(r.url)}" target="_blank" rel="noopener">物件ページ</a>`];
  if (r.map_url) links.push(`<a href="${esc(r.map_url)}" target="_blank" rel="noopener">地図</a>`);
  if (r.salon_url) links.push(`<a href="${esc(r.salon_url)}" target="_blank" rel="noopener">駅のサロン検索</a>`);
  if (r.also_on) links.push(`<a href="${esc(r.also_on)}" target="_blank" rel="noopener">別サイトの掲載</a>`);
  if (b && b.url) links.push(`<a href="${esc(b.url)}" target="_blank" rel="noopener">HOMES の建物ページ</a>`);
  for (const s of (b && b.spaces) || []) links.push(`<a href="${esc(s.url)}" target="_blank" rel="noopener">既存：${esc(s.name)}</a>`);
  const price = r.type === 'homes' ? '' : `<span class="price">${man(r.total)}</span>（${man(r.rent)}＋${man(r.admin)}）／${r.area ?? '-'}㎡／坪${man(r.tsubo)}`;
  const st = (v, txt) => `<button class="${r.status === v ? 'on' : ''}" data-id="${esc(r.id)}" data-v="${v}">${txt}</button>`;
  return `<div class="card${r.status === 'skip' ? ' dim' : ''}">
    <div class="top">${labelBadge(r)}<span class="t">${esc(r.title || r.kind || '（建物名なし）')}</span><span class="meta">${esc(r.site)}・${esc(r.first_seen)}</span></div>
    <div class="meta">${esc(r.kind)} ${esc(r.address)} ${esc(r.stations)}</div>
    <div>${price} ${esc(r.floor || '')} ${esc(r.madori || '')}</div>
    ${r.match_reason ? `<div class="reason">${esc(r.match_reason)}</div>` : ''}
    ${drop ? `<div class="reason">値下げ ${man(drop.from)} → ${man(drop.to)}</div>` : ''}${r.relist ? '<div class="reason">再掲</div>' : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="links">${links.join('')}</div>
    <div class="st">${st('consider', '検討する')}${st('skip', '見送り')}${st('', '印なし')}</div>
  </div>`;
}

function healthLine(summary) {
  if (!summary) return '<span class="bad">巡回の記録がまだありません</span>';
  const parts = [`<span>最後の巡回 ${esc(summary.at)}</span>`];
  for (const [k, v] of Object.entries(summary.sources || {})) {
    const bad = v.error || v.blocked || v.mayHaveGap || (v.failed && v.failed > 5);
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
<meta name="robots" content="noindex,nofollow"><title>物件監視</title><style>${CSS}</style></head><body>
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
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.st button'); if (!b) return;
  const r = await fetch('/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id, status: b.dataset.v }) });
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
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>物件監視</title><style>${CSS}.box{max-width:380px;margin:60px auto;padding:0 16px}.box input,.box button{font:inherit;width:100%;padding:8px;margin-top:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}.box button{background:var(--ink);color:var(--bg);cursor:pointer}</style></head><body><div class="box"><h1>物件監視</h1>${msg ? `<p>${esc(msg)}</p>` : ''}<form method="post" action="/login"><input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required><button>ログインリンクを送る</button></form></div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' } });
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

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === '/api/ingest' && request.method === 'POST') return ingest(request, env);
    if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
    if (u.pathname === '/login' && request.method === 'POST') return postLogin(request, env);
    if (u.pathname === '/auth') return auth(request, env);
    if (u.pathname === '/logout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    const who = (await sessionUser(request, env)) || (await verifyAccess(request, env));
    if (!who) return loginHtml('');
    if (u.pathname === '/api/status' && request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== u.host) return new Response('forbidden', { status: 403 });
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
