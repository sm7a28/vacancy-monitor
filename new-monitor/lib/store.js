// 暗号化した JSON の読み書き。
// このリポジトリは公開なので、候補の建物・見つけた募集・既読の記録は暗号化して置く。
// 鍵は環境変数 NM_KEY（32バイトを base64 にしたもの）。GitHub では Secrets、手元では new-monitor/.secrets/nm-key.txt。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadKey() {
  let b64 = process.env.NM_KEY;
  if (!b64) {
    const p = path.join(__dirname, '..', '.secrets', 'nm-key.txt');
    if (fs.existsSync(p)) b64 = fs.readFileSync(p, 'utf8').trim();
  }
  if (!b64) throw new Error('NM_KEY がありません');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('NM_KEY の長さが違います');
  return key;
}

function encrypt(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decrypt(text, key) {
  const o = JSON.parse(text);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  const out = Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]);
  return JSON.parse(out.toString('utf8'));
}

function readEnc(file, key, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return decrypt(fs.readFileSync(file, 'utf8'), key);
}

function writeEnc(file, obj, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encrypt(obj, key) + '\n');
}

module.exports = { loadKey, encrypt, decrypt, readEnc, writeEnc };
