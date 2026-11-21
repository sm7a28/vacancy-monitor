// 新しい監視の巡回（1回分）。GitHub Actions から1日4回動かす。
// 1. SUUMO（事務所利用可・新着順）  2. アットホーム（事業用・新着順・1回4ページまで）  3. HOMES の建物ページ（Worker 経由）
// 見つけたものは new-monitor/results/ に暗号化して残す。Discord に送るのは NM_NOTIFY=1 のときだけ。
// ログ（公開される）には件数だけを出し、物件や建物の名前は出さない。
'use strict';
const fs = require('fs');
const path = require('path');
const { loadKey, readEnc, writeEnc } = require('./lib/store');
const { sleep, getText, jstStamp, jstDate, chomeKey, parseYen } = require('./lib/util');
// 実績ビル系は坪単価を問わず、家賃（管理費込み）17万円までなら拾う（2026-11-21 ユーザー「17万にするか 坪の制限はなしで」）
const JISSEKI_MAX_TOTAL = 170000;
const suumo = require('./lib/suumo');
const athome = require('./lib/athome');
const { judge } = require('./lib/area');
const { matchListing, matchInquiry } = require('./lib/match');
const notify = require('./lib/notify');

const DIR = __dirname;
const STATE_FILE = process.env.NM_STATE_FILE || path.join(DIR, 'state', 'state.json.enc');
const RESULTS_DIR = process.env.NM_RESULTS_DIR || path.join(DIR, 'results');
const CAND_FILE = path.join(DIR, 'data', 'candidates.json.enc');
const KEEP_DAYS = 45;

const today = () => Math.floor(Date.now() / 86400000);

function fingerprint(x) {
  const ck = chomeKey(x.addr);
  if (!ck || !(x.area > 0)) return '';
  return `${ck}|${x.area.toFixed(2)}|${(x.rent || 0) + (x.admin || 0)}`;
}

// 一番近い駅のインスタベースの検索URL。物件に合いそうな業態で検索する（業態の見立てはおおまかでよい。2026-11-20 ユーザー指示）
// 駅コードが分からない駅は Google 検索のリンク
let STATION_CODES = {};
const IB_GENRE = {
  salon: { name: 'サロン', path: (c) => `tokyo-${c}-salon` },
  party: { name: 'パーティー', path: (c) => `tokyo-${c}/list/party` },
  kaigishitsu: { name: '会議室', path: (c) => `tokyo-${c}-kaigishitsu` },
  dance: { name: 'ダンス', path: (c) => `tokyo-${c}-dance` },
};
const DANCE_STATIONS = new Set(['立川', '三鷹', '府中', '調布', '国分寺']);
// 業態ごとの「徒歩ぎりぎり圏内」と、向く広さの目安（2026-11-20 ユーザー指示：ダンス10分・サロン5分・パーティー7分・会議室4分）
const GENRE_WALK = { dance: 10, salon: 5, party: 7, kaigishitsu: 4 };
const GENRE_MIN_AREA = { dance: 25, salon: 0, party: 20, kaigishitsu: 0 };
const nearest = (x) => (x.stations || []).filter((s) => s.station && s.walk != null).sort((a, b) => a.walk - b.walk)[0];
// 向いていそうな業態を順に並べ、広さと徒歩の両方が合う最初のものを返す。どれも合わなければ null（実績ビル以外は拾わない）
function genreOrder(x, j) {
  const area = x.area || 0;
  const st = ((x.stations || [])[0] || {}).station || '';
  const low = (j.tags || []).some((t) => t === '地下' || t === '1階');
  if (DANCE_STATIONS.has(st) && area >= 25) return ['dance', 'party', 'salon', 'kaigishitsu'];
  if (area >= 30 || (low && area >= 20)) return ['party', 'dance', 'salon', 'kaigishitsu'];
  return ['salon', 'party', 'dance', 'kaigishitsu'];
}
function guessGenre(x, j) {
  const st = nearest(x);
  if (!st) return null;
  return genreOrder(x, j).find((g) => (x.area || 0) >= GENRE_MIN_AREA[g] && st.walk <= GENRE_WALK[g]) || null;
}
function instabaseLinks(x, j) {
  const st = nearest(x);
  if (!st) return null;
  const name = st.station.replace(/駅$/, '');
  const code = STATION_CODES[name];
  const genre = guessGenre(x, j) || genreOrder(x, j)[0];
  const url = (g) => (code ? `https://www.instabase.jp/${IB_GENRE[g].path(code)}` : `https://www.google.com/search?q=${encodeURIComponent(`インスタベース ${name}駅 ${IB_GENRE[g].name}`)}`);
  return { station: name, genre, genreName: IB_GENRE[genre].name, url: url(genre), all: Object.fromEntries(Object.keys(IB_GENRE).map((g) => [g, url(g)])) };
}

async function main() {
  const key = loadKey();
  const cand = readEnc(CAND_FILE, key, null);
  if (!cand) throw new Error('候補の建物のファイルがありません');
  STATION_CODES = cand.stationCodes || {};
  const state = readEnc(STATE_FILE, key, { runCount: 0, seen: {}, fps: {}, seeded: {}, homes: {} });
  const runIndex = state.runCount || 0;
  const d0 = today();
  const seenSet = new Set(Object.keys(state.seen));
  const events = [];
  const summary = { at: jstStamp(), runIndex, sources: {} };
  const only = (process.env.NM_ONLY || '').split(',').filter(Boolean);
  const want = (k) => only.length === 0 || only.includes(k);

  function consider(x, sourceKey, seeding) {
    const s = summary.sources[sourceKey];
    const known = state.seen[x.id];
    const j = judge(x);
    const fp = fingerprint(x);
    if (known) {
      // 値下げ（条件に合うものだけ）
      if (j.pass && known.t && j.total && j.total < known.t) {
        events.push({ type: 'listing', source: sourceKey, listing: x, judge: j, match: matchListing(x, cand.buildings), priceDrop: { from: known.t, to: j.total } });
        s.priceDrops++;
      }
      known.d = d0;
      if (j.total) known.t = j.total;
      return;
    }
    s.fresh++;
    state.seen[x.id] = { d: d0, t: j.total || 0 };
    seenSet.add(x.id);
    if (seeding) return;
    let preMatch = null;
    if (!j.pass) {
      // 駅・広さ・地域の条件は通っていて（tier が付いている）、家賃・坪で落ちた物件だけ、実績ビルなら拾い直す
      preMatch = j.tier ? matchListing(x, cand.buildings) : null;
      if (!(preMatch && preMatch.label && j.total && j.total <= JISSEKI_MAX_TOTAL)) { s.rejected++; return; }
      j.pass = true;
      j.tags.push('坪単価は実績ビルのため問わない');
      s.jissekiOverTsubo = (s.jissekiOverTsubo || 0) + 1;
    }
    const match = preMatch || matchListing(x, cand.buildings);
    // 業態ごとの徒歩圏内に入らない物件は、実績ビル系でなければ拾わない
    if (!match.label && !guessGenre(x, j)) { s.tooFar = (s.tooFar || 0) + 1; return; }
    s.passed++;
    const ev = { type: 'listing', source: sourceKey, listing: x, judge: j, match };
    if (fp && state.fps[fp] && state.fps[fp].id !== x.id) {
      const prev = state.fps[fp];
      if (prev.site !== x.site) { ev.duplicateOf = prev; ev.alsoOn = prev.url; s.duplicates++; }
      else if (d0 - prev.d >= 3) { ev.relist = true; }
    }
    if (fp) state.fps[fp] = { id: x.id, site: x.site, url: x.url, d: d0 };
    const inq = matchInquiry(x, cand.inquiries);
    if (inq) { ev.inquired = { same: inq.same, asked: inq.q.asked, via: inq.q.via || '', result: inq.q.result }; j.tags.unshift(`${inq.same === 'listing' ? '問い合わせ済み' : '同じ建物に問い合わせ済み'}（${inq.q.via ? inq.q.via + ' ' : ''}${inq.q.asked}：${inq.q.result}）`); }
    ev.mapUrl = notify.mapLink(x);
    ev.ib = instabaseLinks(x, j);
    ev.salonUrl = ev.ib ? ev.ib.url : '';
    ev.label = ev.match.label || '';
    // 知らせる対象：実績ビル系は全部。向いてる物件は重点・ピンポイントと、地下・1階だけ（ふつうの地域は件数が多すぎるため記録のみ。2026-11-19）
    ev.notify = !!ev.label || j.tier !== 'normal' || j.tags.includes('地下') || j.tags.includes('1階');
    // 別サイトで先に知らせた部屋は、短く添えるだけ（速さ重視：先に出た方で知らせる）
    ev.kindLabel = ev.duplicateOf ? '同じ部屋の別サイト掲載' : '';
    events.push(ev);
  }

  // 1. SUUMO
  // 毎回「本日の新着」を全ページ。朝（JST 10時前）の回は「新着(2-7日前)」も全ページ読んで、前の晩の分を拾う
  const hourJst = new Date(Date.now() + 9 * 3600e3).getUTCHours();
  const modes = [{ recent: false }];
  if (hourJst < 10 || process.env.NM_SUUMO_RECENT === '1') modes.push({ recent: true });
  for (const s of suumo.SEARCHES) {
    for (const m of modes) {
      const k = m.recent ? `${s.key}-recent` : `${s.key}-today`;
      if (!want(s.key) && !want(k)) continue;
      const seeding = !state.seeded[k] && process.env.NM_NO_SEED !== '1';
      summary.sources[k] = { pages: 0, rooms: 0, fresh: 0, passed: 0, rejected: 0, duplicates: 0, priceDrops: 0, seeding };
      try {
        const r = await suumo.fetchSearch(s, seenSet, { maxPages: m.recent ? 45 : 20, recent: m.recent });
        summary.sources[k].pages = r.log.length;
        summary.sources[k].rooms = r.rooms.length;
        summary.sources[k].hit = r.hit;
        summary.sources[k].pageLog = r.log;
        const pref = s.ta === 14 ? 'kanagawa' : 'tokyo';
        // 掲載日：一覧には載っていない。「本日の新着」で見つけたものはその日に載ったもの
        const posted = m.recent ? '2〜7日前（SUUMO の新着2〜7日前）' : `${jstDate().slice(5).replace('-', '/')}（SUUMO の本日の新着）`;
        for (const x of r.rooms) consider({ ...x, pref, posted }, k, seeding);
        const last = r.log[r.log.length - 1];
        if (last && last.rooms > 0 && r.log.length >= (m.recent ? 45 : 20)) summary.sources[k].mayHaveGap = true;
        state.seeded[k] = true;
      } catch (e) {
        summary.sources[k].error = String(e).slice(0, 200);
      }
      await sleep(3000);
    }
  }

  // 掲載から5日を過ぎた物件は価値がないので拾わない（2026-11-20 ユーザー指示）
  const MAX_AGE_DAYS = 5;
  const todayJst = jstDate().replace(/-/g, '/');
  const ageDays = (ymd) => Math.round((Date.parse(todayJst.replace(/\//g, '-')) - Date.parse(ymd.replace(/\//g, '-'))) / 86400000);
  const dropEvent = (ev) => { const i = events.indexOf(ev); if (i >= 0) events.splice(i, 1); };

  // SUUMO の掲載日：一覧には載っていないので、条件に合った新着だけ物件ページを開いて「情報更新日」を取る
  {
    const targets = events.filter((ev) => ev.listing && ev.listing.site === 'suumo').slice(0, 150);
    const src = (summary.sources.suumoDetail = { tried: targets.length, ok: 0, failed: 0, tooOld: 0 });
    for (const ev of targets) {
      try {
        const d = await suumo.fetchDetail(ev.listing.url);
        if (d.updated) {
          ev.listing.posted = `${d.updated}（情報更新日）`;
          src.ok++;
          if (ageDays(d.updated) > MAX_AGE_DAYS) { dropEvent(ev); src.tooOld++; }
        } else src.failed++;
      } catch { src.failed++; }
      await sleep(1500);
    }
  }

  // 2. アットホーム
  // 1回の巡回で取るのは4ページまで（5〜6回目で認証画面が出る）。東京の3種類の一覧のあと、
  // 4つ目は「知らせる対象の物件ページ（情報公開日を取る）」があればそれを、なければ神奈川の一覧（持ち回り）を取る
  const updates = [];
  if (want('athome')) {
    try {
      const list = athome.plan(runIndex);
      const kanagawa = list.find((s) => /kanagawa/.test(s.key));
      let blocked = false;
      const handle = (res) => {
        const seeding = !state.seeded[res.key] && process.env.NM_NO_SEED !== '1';
        const src = (summary.sources[res.key] = { status: res.status, blocked: res.blocked || false, skipped: res.skipped, rooms: res.items.length, fresh: 0, passed: 0, rejected: 0, duplicates: 0, priceDrops: 0, seeding });
        // URLの絞り込み（20万円以下・徒歩10分以内）が効いているかを結果で確かめる
        src.overPrice = res.items.filter((x) => x.rent > 200000).length;
        src.overWalk = res.items.filter((x) => (x.stations[0] || {}).walk > 10).length;
        src.underArea = res.items.filter((x) => x.area < 10).length;
        const pref = /kanagawa/.test(res.key) ? 'kanagawa' : 'tokyo';
        // 「NEW」の印がない物件は、新着順の上位にいても公開から日が経っている（更新で上がってきただけ）ので拾わない
        src.notNew = 0;
        for (const x of res.items) {
          if (x.isNew === false) {
            src.notNew++;
            if (!state.seen[x.id]) state.seen[x.id] = { d: d0, t: 0 };
            else state.seen[x.id].d = d0;
            continue;
          }
          consider({ ...x, pref }, res.key, seeding);
        }
        if (!seeding && res.items.length > 0 && src.fresh === res.items.length) src.mayHaveGap = true;
        if (res.items.length > 0) state.seeded[res.key] = true;
        if (res.blocked) blocked = true;
      };
      for (const s of list.filter((x) => x !== kanagawa)) {
        if (blocked) { summary.sources[s.key] = { skipped: 'blocked-earlier' }; continue; }
        handle(await athome.fetchList(s));
        await sleep(30000);
      }
      // 情報公開日を取る順番待ち（今回の知らせる対象を先に）
      const queue = (state.athomeDetailQueue || []).filter((q) => d0 - q.d <= 7);
      for (const ev of events) {
        if (ev.listing && ev.listing.site === 'athome' && ev.notify && !queue.some((q) => q.id === ev.listing.id)) queue.unshift({ id: ev.listing.id, url: ev.listing.url, d: d0 });
      }
      const src = (summary.sources.athomeDetail = { queued: queue.length, ok: 0 });
      if (!blocked && queue.length) {
        const q = queue.shift();
        const d = await athome.fetchDetail(q.url);
        if (d.blocked) { blocked = true; queue.unshift(q); src.blocked = true; }
        else if (d.kokai) {
          src.ok = 1;
          const posted = `${d.kokai}（情報公開日）`;
          const ev = events.find((e) => e.listing && e.listing.id === q.id);
          if (ev) {
            ev.listing.posted = posted;
            if (ageDays(d.kokai) > MAX_AGE_DAYS) { dropEvent(ev); src.tooOld = 1; }
          } else updates.push({ id: q.id, posted });
        }
      } else if (!blocked && kanagawa) {
        handle(await athome.fetchList(kanagawa));
      }
      state.athomeDetailQueue = queue.slice(0, 30);
      summary.athomeBlocked = blocked;
    } catch (e) {
      summary.sources.athome = { error: String(e).slice(0, 200) };
    }
  }

  // 3. HOMES の建物ページ（Worker 経由）
  if (want('homes') && process.env.NM_HOMES_URL && process.env.NM_HOMES_TOKEN) {
    const src = (summary.sources.homes = { buildings: 0, ok: 0, failed: 0, noSection: 0, withRooms: 0, newRooms: 0, captcha: 0 });
    // 失敗した建物は最後にもう一巡（HOMES が一時的に 202 を返すことがある）
    const queue = cand.homesTargets.map((t) => ({ t, pass: 1 }));
    src.buildings = queue.length;
    while (queue.length) {
      const { t, pass } = queue.shift();
      const b = (t.href.match(/b-(\d+)/) || [])[1];
      if (!b) continue;
      if (pass === 2 && queue.every((q) => q.pass === 2) && !src._waited) { src._waited = true; await sleep(60000); }
      let j = null;
      for (let attempt = 0; attempt < 2 && !j; attempt++) {
        if (attempt) await sleep(8000);
        try {
          const r = await getText(`${process.env.NM_HOMES_URL}/homes?b=${b}`, { 'x-nm-token': process.env.NM_HOMES_TOKEN });
          if (r.status !== 200) { src.failStatus = src.failStatus || {}; src.failStatus[`worker${r.status}`] = (src.failStatus[`worker${r.status}`] || 0) + 1; continue; }
          const parsed = JSON.parse(r.text);
          if (!parsed.ok && !parsed.captcha) { src.failStatus = src.failStatus || {}; src.failStatus[`homes${parsed.status}`] = (src.failStatus[`homes${parsed.status}`] || 0) + 1; continue; }
          j = parsed;
        } catch (e) {
          src.failStatus = src.failStatus || {};
          src.failStatus.exception = (src.failStatus.exception || 0) + 1;
        }
      }
      if (!j && pass === 1) { queue.push({ t, pass: 2 }); await sleep(3000); continue; }
      if (!j) { src.failed++; await sleep(3000); continue; }
      if (!j.ok) { src.failed++; if (j.captcha) { src.captcha++; break; } continue; }
      if (j.count > 0 && j.rooms.length === 0) src.countButNoRooms = (src.countButNoRooms || 0) + 1;
      src.ok++;
      const prev = state.homes[b];
      // 欄が見つからない形のページが返ることがある。そのときは前の記録のまま（消えた扱いにしない）
      if (!j.hasRoomSection && !j.none) { src.noSection++; await sleep(3000); continue; }
      const urls = j.rooms.map((r) => r.url);
      if (urls.length) src.withRooms++;
      if (prev) {
        for (const room of j.rooms) {
          if (!prev.rooms.includes(room.url)) {
            src.newRooms++;
            const inq = matchInquiry({ url: room.url, name: t.name, addr: {} }, cand.inquiries);
            // HOMES の部屋も家賃（管理費込み）17万円まで知らせる。超えるものは記録のみ（2026-11-21）
            const rTotal = (parseYen(room.rent || '') || 0) + (parseYen(room.admin || '') || 0);
            const overMax = rTotal > JISSEKI_MAX_TOTAL;
            events.push({ type: 'homes', source: 'homes', label: '実績ビル', notify: overMax ? false : undefined, total: rTotal || undefined, buildingKey: t.key, buildingName: t.name, buildingUrl: t.href, room, building: j.building, spaces: ((cand.buildings.find((x) => x.key === t.key) || {}).spaces || []).slice(0, 5), inquired: inq ? { same: inq.same, asked: inq.q.asked, via: inq.q.via || '', result: inq.q.result } : undefined });
          }
        }
      }
      state.homes[b] = { rooms: urls, d: d0, building: j.building };
      await sleep(6000);
    }
    delete src._waited;
  }

  // 古い既読を捨てる
  for (const [id, v] of Object.entries(state.seen)) if (d0 - (v.d || 0) > KEEP_DAYS) delete state.seen[id];
  for (const [fp, v] of Object.entries(state.fps)) if (d0 - (v.d || 0) > KEEP_DAYS) delete state.fps[fp];
  state.runCount = runIndex + 1;

  // 写真からスタジオの居抜きを見分ける（Claude API。キーがあるときだけ）（2026-11-21）
  if (process.env.ANTHROPIC_API_KEY && process.env.NM_NO_VISION !== '1') {
    try { summary.sources.vision = await require('./lib/vision').checkEvents(events); }
    catch (e) { summary.sources.vision = { error: String(e).slice(0, 200) }; }
  }

  // 結果を残す
  for (const ev of events) ev.text = notify.format(ev);
  const resFile = path.join(RESULTS_DIR, `${jstDate()}.json.enc`);
  const day = readEnc(resFile, key, { runs: [] });
  day.runs.push({ summary, events });
  writeEnc(resFile, day, key);
  writeEnc(STATE_FILE, state, key);

  // ダッシュボードに送る
  if (process.env.NM_DASH_URL && process.env.NM_DASH_TOKEN) {
    try {
      const slim = events.map((ev) => ({ ...ev, listing: ev.listing ? { ...ev.listing, images: (ev.listing.images || []).slice(0, 4) } : undefined }));
      const res = await fetch(`${process.env.NM_DASH_URL}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nm-token': process.env.NM_DASH_TOKEN }, body: JSON.stringify({ summary: { ...summary, sources: Object.fromEntries(Object.entries(summary.sources).map(([k, v]) => { const { pageLog, ...rest } = v; return [k, rest]; })) }, events: slim, updates }) });
      summary.dashboard = res.status;
    } catch (e) { summary.dashboard = String(e).slice(0, 100); }
  }

  // 送る（試運転中は送らない）
  let sent = 0;
  if (process.env.NM_NOTIFY === '1' && process.env.DISCORD_WEBHOOK_URL) {
    for (const ev of events) {
      if (ev.duplicateOf || ev.notify === false) continue;
      if (await notify.send(ev, process.env.DISCORD_WEBHOOK_URL)) sent++;
      await sleep(1200);
    }
  }

  // ログ（件数だけ）
  const counts = {};
  for (const ev of events) { const k = (ev.label || '向いてる物件') + (ev.notify === false ? '（記録のみ）' : ''); counts[k] = (counts[k] || 0) + 1; }
  console.log(`巡回 ${summary.at}（${runIndex + 1}回目）`);
  for (const [k, v] of Object.entries(summary.sources)) {
    const { pageLog, ...rest } = v;
    console.log(`  ${k}: ${JSON.stringify(rest)}`);
  }
  console.log(`  ダッシュボード: ${summary.dashboard ?? '未設定'}`);
  console.log(`  見つけたもの: ${JSON.stringify(counts)}  送信: ${sent}件${process.env.NM_NOTIFY === '1' ? '' : '（試運転のため送らない）'}`);
}

main().catch((e) => {
  console.error('止まりました:', e.message);
  process.exit(1);
});
