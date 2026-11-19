'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja', ...extraHeaders },
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, text };
}

// 全角→半角などをそろえる
function nfkc(s) {
  return String(s || '').normalize('NFKC');
}

function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// 「14.3万円」「10000円」「5,000円」「なし」「-」→ 円
function parseYen(s) {
  const t = nfkc(s).replace(/[,\s]/g, '');
  if (!t || /^(なし|無|-|－|―)$/.test(t)) return 0;
  let m = t.match(/([\d.]+)\s*万\s*([\d]+)?\s*円?/);
  if (m) return Math.round(parseFloat(m[1]) * 10000) + (m[2] ? parseInt(m[2], 10) : 0);
  m = t.match(/([\d.]+)\s*円/);
  if (m) return Math.round(parseFloat(m[1]));
  return NaN;
}

function parseArea(s) {
  const m = nfkc(s).replace(/[,\s]/g, '').match(/([\d.]+)m/);
  return m ? parseFloat(m[1]) : NaN;
}

// 「千代田区神田佐久間町2丁目15」「中央区湊1」→ { ward, town, chome }
function parseAddress(s) {
  let t = nfkc(s).replace(/\s+/g, '').replace(/^(東京都|神奈川県)/, '');
  const m = t.match(/^(.+?[区市])(.+?区)?(.*)$/);
  if (!m) return { ward: '', town: '', chome: null, raw: t };
  let ward = m[1] + (m[2] || '');
  let rest = m[3] || '';
  const cm = rest.match(/^(.*?)(\d+)(丁目|-|$|\D)/);
  let town = rest, chome = null;
  if (cm) { town = cm[1]; chome = parseInt(cm[2], 10); }
  town = town.replace(/[ヶケが]/g, 'ケ');
  return { ward, town, chome, raw: t };
}

function chomeKey(a) {
  if (!a || !a.ward || !a.town) return '';
  return `${a.ward}${a.town}${a.chome == null ? '' : a.chome}`;
}

function jstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

function jstStamp() {
  return jstNow().toISOString().replace('T', ' ').slice(0, 16);
}

function jstDate() {
  return jstNow().toISOString().slice(0, 10);
}

module.exports = { UA, sleep, getText, nfkc, stripTags, parseYen, parseArea, parseAddress, chomeKey, jstStamp, jstDate, jstNow };
