'use strict';

const assert = require('assert');
const {
  extractBuildingListingLinks,
  BLDG_LINK_RULES,
} = require('./rental-watcher');

const homesRule = BLDG_LINK_RULES.find(rule => rule.site === 'HOMES');
const athomeRule = BLDG_LINK_RULES.find(rule => rule.site === 'AtHome');
const homesLinks = [
  'https://www.homes.co.jp/chintai/room/aaaaaaaaaaaaaaaa/',
  'https://www.homes.co.jp/chintai/room/bbbbbbbbbbbbbbbb/',
  'https://www.homes.co.jp/chintai/room/cccccccccccccccc/',
];

assert.deepStrictEqual(
  extractBuildingListingLinks(homesRule, {
    bodyText: '当サイト内で募集中の部屋情報はありません\n周辺の募集中の物件を見る',
    links: homesLinks,
  }),
  [],
  '対象ビルが0件なら周辺物件リンクを採用しない',
);

assert.deepStrictEqual(
  extractBuildingListingLinks(homesRule, {
    bodyText: '古い建物情報ページ\n周辺の問合せ可能な物件',
    links: homesLinks,
  }),
  [],
  '募集中件数が確認できない旧形式ページは誤通知防止のため0件扱い',
);

assert.deepStrictEqual(
  extractBuildingListingLinks(homesRule, {
    bodyText: '建物の部屋情報\n募集中 2 件\n周辺の問合せ可能な物件',
    links: homesLinks,
  }),
  homesLinks.slice(0, 2),
  '対象ビルの募集中件数を超える周辺物件リンクを除外する',
);

assert.deepStrictEqual(
  extractBuildingListingLinks(athomeRule, {
    bodyText: '',
    links: ['https://www.athome.co.jp/rent_office/1234567890/'],
  }),
  ['https://www.athome.co.jp/rent_office/1234567890/'],
  'AtHomeの既存抽出には影響しない',
);

console.log('building page extraction tests: OK');
