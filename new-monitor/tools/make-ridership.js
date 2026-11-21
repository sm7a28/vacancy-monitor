// 駅の乗降客数の表（new-monitor/data/ridership.json）を作る。
// 元データ：国土数値情報「駅別乗降客数データ」S12-25（国土交通省。2024年度まで）
//   https://nlftp.mlit.go.jp/ksj/gml/data/S12/S12-25/S12-25_GML.zip を展開した UTF-8/S12-25_NumberOfPassengers.geojson
// 使い方：node new-monitor/tools/make-ridership.js <geojson のパス>
// （2026-11-21 ユーザー「最寄り駅の乗降客数のってなくないか」。通知の駅の横に出す）
'use strict';
const fs = require('fs');
const path = require('path');
const { normStation } = require('../lib/area');

const src = process.argv[2];
if (!src) { console.error('geojson のパスを渡してください'); process.exit(1); }
const g = JSON.parse(fs.readFileSync(src, 'utf8'));

// 東京都と神奈川県の東側だけ（同じ名前の地方の駅を混ぜないため）
const inArea = (lon, lat) => lat > 35.2 && lat < 35.95 && lon > 139.0 && lon < 140.0;

// 同じ駅（会社・路線をまたいだ駅のまとまり＝S12_001g）ごとに足す。
// 2024年度の欄：S12_058＝重複コード（1 が代表。2 以降は同じ数字の重複で 0）、S12_061＝乗降客数
// JR 東日本など乗車人員しか出していない会社は、国土数値情報の側で2倍して乗降客数にしてある
const groups = new Map();
for (const f of g.features) {
  const p = f.properties;
  const c = f.geometry.coordinates;
  const [lon, lat] = Array.isArray(c[0][0]) ? c[0][0] : c[0];
  if (!inArea(lon, lat)) continue;
  const k = p.S12_001g;
  if (!groups.has(k)) groups.set(k, { name: normStation(p.S12_001), lon, lat, total: 0 });
  if (p.S12_058 === 1 && p.S12_061 > 0) groups.get(k).total += p.S12_061;
}

// 同じ名前のまとまりが複数あるとき（浅草のつくばエクスプレスなど）は、
// 一番大きいものから 1.5km 以内のものだけ足す。離れている同名の駅は足さない
const km = (a, b) => Math.hypot((a.lon - b.lon) * 91, (a.lat - b.lat) * 111);
const byName = new Map();
for (const v of groups.values()) {
  if (!v.total) continue;
  if (!byName.has(v.name)) byName.set(v.name, []);
  byName.get(v.name).push(v);
}
const stations = {};
for (const [name, list] of byName) {
  list.sort((a, b) => b.total - a.total);
  stations[name] = list.filter((v) => km(v, list[0]) <= 1.5).reduce((s, v) => s + v.total, 0);
}

const out = { source: '国土数値情報 駅別乗降客数データ（国土交通省）', year: 2024, unit: '人/日', stations };
const dest = path.join(__dirname, '..', 'data', 'ridership.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`${Object.keys(stations).length} 駅を書き出し：${dest}`);
