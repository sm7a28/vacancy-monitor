'use strict';

const fs   = require('fs');
const path = require('path');

// ================================================================
// ファイルログ
// ================================================================

const LOG_FILE = path.join(__dirname, 'rental-watcher.log');

function log(level, msg) {
  const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const line = `[${ts}] [${level}] ${msg}`;
  // ファイル書き込みを先に行う（コンソール未接続環境でconsole.logが
  // 例外を投げてプロセスが落ちても、ログだけは確実に残す）
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  try { console.log(line); } catch (_) { /* コンソール未接続時は無視 */ }
}

const logger = {
  info:  msg => log('INFO',  msg),
  warn:  msg => log('WARN',  msg),
  error: msg => log('ERROR', msg),
};
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ================================================================
// 設定
// ================================================================

function loadConfig() {
  const basePath  = path.join(__dirname, 'config.base.json');
  const localPath = path.join(__dirname, 'config.json');

  let config = {};
  if (fs.existsSync(basePath))  config = { ...config, ...JSON.parse(fs.readFileSync(basePath,  'utf-8')) };
  if (fs.existsSync(localPath)) config = { ...config, ...JSON.parse(fs.readFileSync(localPath, 'utf-8')) };

  // GitHub Actions 等 CI 環境: 環境変数で機密値を上書き
  if (process.env.DISCORD_WEBHOOK_URL)  config.discordWebhookUrl  = process.env.DISCORD_WEBHOOK_URL;
  if (process.env.GEMINI_API_KEY)       config.geminiApiKey       = process.env.GEMINI_API_KEY;
  if (process.env.SPREADSHEET_ID)       config.spreadsheetId      = process.env.SPREADSHEET_ID;
  if (process.env.SERVICE_ACCOUNT_JSON) {
    const tmpPath = path.join(__dirname, '_sa.json');
    fs.writeFileSync(tmpPath, process.env.SERVICE_ACCOUNT_JSON, 'utf-8');
    config.serviceAccountKeyPath = '_sa.json';
  }

  const required = ['discordWebhookUrl', 'spreadsheetId', 'geminiApiKey', 'serviceAccountKeyPath'];
  for (const key of required) {
    if (!config[key]) throw new Error(`config に ${key} が必要です`);
  }
  return config;
}

// ================================================================
// Google Sheets
// ================================================================

const SHEET_NAME = '監視リスト';

// 列インデックス（0始まり）
const COL = {
  NAME:       1,  // B: 物件名
  ADDRESS:    2,  // C: 住所
  BUILDING:   3,  // D: ビル名
  KNOWN_URLS: 10, // K: 既知URL
  LAST_CHECK: 11, // L: 最終チェック
  HIT_COUNT:  12, // M: ヒット数
};

async function getSheetsClient(keyFilePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(__dirname, keyFilePath),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function loadMonitoringList(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:M`,
  });

  const rows = res.data.values || [];
  const list = [];

  rows.forEach((row, i) => {
    if (i === 0) return; // ヘッダースキップ

    const name     = (row[COL.NAME]     || '').trim();
    const address  = (row[COL.ADDRESS]  || '').trim();
    const building = (row[COL.BUILDING] || '').trim();
    if (!name && !address) return;

    const knownUrlsRaw = row[COL.KNOWN_URLS] || '';
    const knownUrls = knownUrlsRaw
      ? knownUrlsRaw.split(',').map(u => u.trim()).filter(Boolean)
      : [];

    const lastCheckRaw = row[COL.LAST_CHECK] || '';

    // 建物名は "/" 区切りで複数指定可能（地図とビジプロで表記が違うケース等）
    // building       = 検索クエリ用（先頭の1つだけ）
    // buildingNames  = タイトル/h1チェック・Geminiプロンプト用（全部）
    const buildingNames = building
      ? building.split('/').map(s => s.trim()).filter(Boolean)
      : [];
    const buildingPrimary = buildingNames[0] || '';

    list.push({
      sheetRow: i + 1, // シートの行番号（1始まり、ヘッダーが行1）
      name, address,
      building: buildingPrimary,
      buildingNames,
      knownUrls, lastCheckRaw,
    });
  });

  return list;
}

async function updateSheet(sheets, spreadsheetId, updates) {
  if (updates.length === 0) return;

  const data = updates.map(u => ({
    range: `${SHEET_NAME}!K${u.sheetRow}:M${u.sheetRow}`,
    values: [[u.knownUrls, u.lastCheck, u.hitCount]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// ================================================================
// Gemini 新着判定
// ================================================================

async function judgeNewUrls(model, item, candidateUrls) {
  if (candidateUrls.length === 0) return [];

  const knownList  = item.knownUrls.length > 0 ? item.knownUrls.join('\n') : 'なし';
  const foundList  = candidateUrls.join('\n');

  // 建物名の別表記（地図注記とビジネスプロフィールで違うケース等）
  const buildingLabel = (item.buildingNames && item.buildingNames.length > 1)
    ? `${item.buildingNames.join(' または ')}（同じ建物の別表記）`
    : (item.building || '');

  const prompt = `不動産物件URLの分析をしてください。

建物情報:
- 名前: ${item.name}
- 住所: ${item.address}${buildingLabel ? ' ' + buildingLabel : ''}

既に登録済みのURL:
${knownList}

今回新たに見つかったURL候補:
${foundList}

【抽出条件】以下を全て満たすURLのみを返してください:
1. SUUMO・HOMES・CHINTAI・アットホーム・オフィスナビ等の不動産仲介サイトに掲載されている「テナント・オフィス・店舗（事業用）の賃貸募集ページ」である（居住用マンション・アパートの居室は対象外）
2. 検索結果一覧ページではなく、特定物件の詳細ページである（URLに /detail/ /bukken/ /物件ID等 が含まれる個別ページ）
3. 現在も募集中である（「掲載終了」「現在募集なし」「成約済み」のページは除外）
4. この建物の住所・物件と関連性がある
5. 登録済みURLと実質的に同一でない（URLパラメータの違いは同一とみなす）

【必ず除外するもの】
- 検索条件で絞り込んだ物件一覧ページ（例: suumo.jp/chintai/tokyo/list/...）
- 時間貸し・日貸しのスペース予約ページ（時間単位の利用申込）
- 各種教室・スクールの案内ページ
- 口コミサイト・地図サービス・SNS・ブログ
- 過去の掲載情報・アーカイブ（homemate.co.jp/archive/ 等の /archive/ を含むURL）
- 居住用の賃貸物件（マンション・アパートの居住用居室、間取りがワンルーム・1K・2LDK等のもの）
- 投資用物件・収益物件・区分マンション等の投資家向けページ（楽待・健美家・restyle.tokyo等）
- 監視対象テナント自身のウェブサイト（アクセスページ・案内ページ・スケジュールページ等）
- 対象建物が「おすすめ物件」「周辺の物件」「類似物件」「この物件を見た方はこちらも」等のサイドコンテンツとして掲載されているだけのページ（主役が別物件のページは除外）

JSON配列のみで返答してください（余分なテキスト不要）。該当なしの場合は []:
["url1", "url2"]`;

  try {
    const result = await model.generateContent(prompt);
    const text   = result.response.text().trim();
    const match  = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      logger.warn(` Geminiレスポンスのパース失敗 (${item.name})、候補URLをそのまま使用`);
      return candidateUrls;
    }
    return JSON.parse(match[0]);
  } catch (err) {
    logger.error(` Gemini判定失敗 (${item.name}):`, err.message);
    return []; // エラー時は通知しない（誤通知防止）
  }
}

// ================================================================
// 検索エンジン（Yahoo Japan メイン / DuckDuckGo フォールバック）
// ================================================================

const EXCLUDE_YAHOO = [/yahoo\.co\.jp/, /youtube\.com/, /google\.com/];
const EXCLUDE_DDG   = [/duckduckgo\.com/, /youtube\.com/, /bing\.com/, /microsoft\.com/, /yahoo\.co\.jp\/search/];

function extractDDGUrl(href) {
  try {
    const u = new URL(href);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch { return href; }
}

async function searchYahoo(query, page) {
  await page.goto(
    `https://search.yahoo.co.jp/search?p=${encodeURIComponent(query)}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 }
  );
  await new Promise(r => setTimeout(r, 1500));
  const links = await page.$$eval(
    '#contents a',
    els => els.map(a => a.href).filter(h => h && h.startsWith('http'))
  );
  return [...new Set(links)].filter(u => !EXCLUDE_YAHOO.some(p => p.test(u)));
}

async function searchDDG(query, page) {
  await page.goto(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await new Promise(r => setTimeout(r, 1500));
  const rawLinks = await page.$$eval(
    'a.result__a',
    els => els.map(a => a.href).filter(h => h && h.startsWith('http'))
  );
  return [...new Set(rawLinks.map(extractDDGUrl))].filter(u => !EXCLUDE_DDG.some(p => p.test(u)));
}

async function search(query, page) {
  try {
    const results = await searchYahoo(query, page);
    if (results.length > 0) return results;
    logger.info(`Yahoo 0件 → DuckDuckGo フォールバック`);
    return await searchDDG(query, page);
  } catch (err) {
    if (/timeout|TimeoutError/i.test(err.message)) {
      logger.info(`Yahoo タイムアウト → スキップ`);
      return [];
    }
    logger.error(`Yahoo 失敗: ${err.message} → DDG フォールバック`);
    try { return await searchDDG(query, page); }
    catch (err2) {
      logger.error(`DDG も失敗: ${err2.message}`);
      return [];
    }
  }
}

// ================================================================
// 空室確認（Puppeteerでページ内容をチェック）
// ================================================================

const VACANCY_NG_KEYWORDS = [
  '現在募集なし', '空室なし', '空き室なし', '満室', '掲載終了',
  '募集終了', '成約済み', 'この物件は掲載が終了', 'ただいま満室',
  'の募集は終了しました', '募集は終了しました',
  '現在空き物件はありません', '現在、空き物件はありません',
  '現在この物件の募集は終了', '現在入居者募集はしておりません',
  '現在募集中の物件はございません',
  '現在募集中の物件がありません',
  '現在募集中の物件はありません',
  'ただいま募集中の物件はございません',
  '該当する物件が見つかりません',
  '条件に合う物件が見つかりません',
  '物件が見つかりませんでした',
  '募集中の部屋情報はありません',
  '現在募集はありません',
  '募集している区画がございません',
  '募集している区画はございません',
  '募集区画がございません',
  '募集フロアはありません',
  '募集中のフロアはございません',
  '取扱中のお部屋はありません',
  '取扱中の物件はありません',
  '掲載中の物件の情報はありません',
  '周辺の募集中の物件を見てみる',
  '参考物件カタログ',
  '現在募集中の部屋はありません',
  '募集中の部屋はありません',
  'こちらの物件は掲載が終了しております',
  'ページが見つかりません',
  '該当ページがございません',
  '現在募集中の区画なし',
  '現在ご紹介できる物件がありません',
  '募集情報なし',
  '募集情報はありません',
  // 投資家向けページ（収益物件・利回り系）
  '収益物件', '表面利回り', '想定利回り', '投資利回り',
  // スクール・教室自身のサイト（アクセスページ等の誤通知防止）
  '月謝', '入会金',
  // 過去掲載・アーカイブページ
  'このページは過去の掲載内容を元に生成した参考情報',
  'お問い合わせ可能な部屋はありません',
  // 不動産会社の取扱会社情報ページ（ビルに入居している不動産屋の取扱物件が誤検知されるケース）
  'の取扱会社情報',
  // 募集なし（メッセージが画像でも周辺のボタン等がテキストで残るケース）
  '空きが出たら連絡を希望する',
  'この貸室は現在募集',
  '現在この物件は埋まっています',
  '最新の空き状況はお問い合わせください',
  '現在空室情報はございません',
  '申し訳ございません、現在取り扱っている空室はございません',
  '現在、当サイトで掲載しているお部屋はありません',
];

// 数値ゼロ件表記（spacingが揺れるため正規表現で判定）
const VACANCY_ZERO_PATTERNS = [
  /空室区画数[\s：:]*0\s*件/,
  /\[\s*0\s*部屋\s*\]/,
];

// URLレベルで除外するパターン（ページ訪問前に判定）
const URL_NG_PATTERNS = [
  { pattern: /\/archive\//i,                  reason: 'アーカイブURL (/archive/)' },
  { pattern: /\/shop\/shopinfo/i,             reason: '不動産会社店舗情報URL (/shop/shopinfo)' },
  { pattern: /suumo\.jp\/library\//i,         reason: 'SUUMO物件ライブラリー（過去掲載の参考ページ）' },
  { pattern: /canary-app\.jp\/chintai\/buildings\//i, reason: 'カナリー建物プロファイル（賃貸情報なし）' },
  { pattern: /cjs\.ne\.jp\/chintai\/detail_b\//i, reason: '賃貸住宅サービス建物カタログ（募集中の部屋なし）' },
  { pattern: /koenji-f\.jp\/bukken\/r\/search\d+\.html/i, reason: '高円寺不動産の検索結果ページ（個別物件ではない）' },
  { pattern: /\/list(\/|$|\?|\.html)/i,        reason: '物件一覧ページ (/list)' },
];

async function checkVacancyActive(url, item, page) {
  // URLパターンチェック（ページ訪問前に除外）
  for (const { pattern, reason } of URL_NG_PATTERNS) {
    if (pattern.test(url)) {
      logger.info(`空室なし除外: "${reason}" → ${url}`);
      return { active: false, reason };
    }
  }

  try {
    // 動的描画サイト対策: networkidle2 を最大10秒待ち、間に合わなければ domcontentloaded の状態で続行
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    } catch (e) {
      // networkidle2 タイムアウト時は domcontentloaded を再試行
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    if (response && response.status() >= 400) {
      return { active: false, reason: `HTTP ${response.status()} (削除済み・存在しないページ)` };
    }
    // 念のため最低1秒待ってからテキスト抽出（遅延描画パーツ対策）
    await new Promise(r => setTimeout(r, 1000));
    const text = await page.evaluate(() => document.body?.innerText || '');

    // ① 空室NGキーワードチェック
    const hit = VACANCY_NG_KEYWORDS.find(kw => text.includes(kw));
    if (hit) return { active: false, reason: `NGキーワード「${hit}」` };

    const zeroHit = VACANCY_ZERO_PATTERNS.find(pat => pat.test(text));
    if (zeroHit) return { active: false, reason: `ゼロ件表記「${zeroHit}」` };

    // ② 確認日チェック（18ヶ月以上前は古いとみなして除外）
    const confirmDatePatterns = [
      /確認日[：:＊*\s]*(\d{4})[年/](\d{1,2})/,
      /最終確認[：:\s]*(\d{4})[年/](\d{1,2})/,
      /取材日[：:\s]*(\d{4})[年/](\d{1,2})/,
    ];
    for (const pat of confirmDatePatterns) {
      const m = text.match(pat);
      if (m) {
        const year  = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const now = new Date();
        const monthsDiff = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
        if (monthsDiff > 18) {
          return { active: false, reason: `確認日が${year}年${month}月（${monthsDiff}ヶ月前）と古い` };
        }
        break; // 最初に見つかったパターンのみ評価
      }
    }

    // ③ 住所の関連性チェック（対象ビルの住所キーワードがページ内に存在するか）
    // 住所から番地部分（例: "2-15-22"）を抽出して確認
    const buildingNames = item.buildingNames && item.buildingNames.length > 0
      ? item.buildingNames
      : (item.building ? [item.building] : []);
    const addrTokens = [
      ...buildingNames,
      // 住所から市区町村以降を抽出（例: "立川市曙町2-15-22" → "曙町", "2-15-22"）
      ...(item.address.match(/[^\s都道府県]+[区市町村].+/) || [item.address])
        .join('').match(/\S+/g) || [],
    ].filter(Boolean);

    const addressFound = addrTokens.some(token => token.length >= 3 && text.includes(token));
    if (!addressFound) return { active: false, reason: '対象ビルの住所がページ内に見つからない（一覧ページ等の可能性）' };

    // ③-b 番地（X-X-X形式）の厳格チェック：監視対象の番地そのものがページ内に無ければ除外
    // 「百人町1-24-8 を監視中なのに 百人町3-26-1 が表示されている別建物ページ」を弾くため
    const targetStreetNum = item.address.match(/\d+[-－―]\d+[-－―]\d+/)?.[0];
    if (targetStreetNum && !text.includes(targetStreetNum)) {
      return { active: false, reason: `監視対象の番地「${targetStreetNum}」がページ内に見つからない（近隣の別建物の可能性）` };
    }

    // ③-c 賃料上限チェック: ページ内の「賃料/月額/家賃」表記が上限超過なら除外
    // 「表記基準」で判定（万円→円換算 or 円表記をそのまま）
    // 表組みレイアウトでは見出し（月額賃料）と数値の間に他の列（階数・面積等）が挟まるため、
    // ラベル直後だけでなく一定範囲内（120文字）を探索する
    const MAX_RENT_YEN = 300000; // 30万円
    const rentLabelMatch = text.match(/賃料|月額|家賃/);
    let rentYen = null;
    if (rentLabelMatch) {
      const window = text.slice(rentLabelMatch.index, rentLabelMatch.index + 120);
      const manMatch = window.match(/(\d+(?:\.\d+)?)\s*万円/);
      const yenMatch = window.match(/[¥￥]?\s*(\d{1,3}(?:,\d{3})+)\s*円/);
      if (manMatch)      rentYen = Math.round(parseFloat(manMatch[1]) * 10000);
      else if (yenMatch) rentYen = parseInt(yenMatch[1].replace(/,/g, ''), 10);
    }
    if (rentYen !== null && rentYen > MAX_RENT_YEN) {
      return { active: false, reason: `賃料${(rentYen/10000).toFixed(1)}万円が上限30万円超` };
    }

    // ③-d 全室成約済みチェック: 「該当物件N室」の件数と「ご成約」バッジ数が一致したら除外
    // 単純に「成約済」をNGキーワードにすると空き＋成約済み混在ページも除外してしまうため、
    // 件数を数えて「全部成約済み」の場合のみ除外する
    const totalRoomsMatch = text.match(/該当物件\s*(\d+)\s*室/);
    if (totalRoomsMatch) {
      const totalRooms = parseInt(totalRoomsMatch[1], 10);
      const contractedCount = (text.match(/ご成約/g) || []).length;
      if (totalRooms > 0 && contractedCount >= totalRooms) {
        return { active: false, reason: `該当物件${totalRooms}室すべて「ご成約」済み` };
      }
    }

    // ④ 建物名がページの主役か確認（タイトル・h1に建物名または番地が含まれるか）
    // 「おすすめ物件」欄に掲載されているだけのページを除外するため
    if (buildingNames.length > 0) {
      const pageTitle = await page.title().catch(() => '');
      const h1Text    = await page.$eval('h1', el => el.innerText ?? el.textContent ?? '').catch(() => '');
      const mainText  = pageTitle + ' ' + h1Text;
      // いずれかの建物名 or 番地（ハイフン区切り数字3段）がタイトル/h1に含まれるかチェック
      const streetNum   = item.address.match(/\d+-\d+-\d+/)?.[0] ?? '';
      const inMainText  = buildingNames.some(b => mainText.includes(b))
                       || (streetNum && mainText.includes(streetNum));
      if (!inMainText) {
        return { active: false, reason: `建物名・番地がタイトル/h1に見当たらない（おすすめ欄掲載の可能性）` };
      }
    }

    return { active: true };
  } catch (err) {
    // 致命的な接続エラー（ドメイン不在、SSLエラー、接続拒否、アドレス解決不可など）は除外する
    const isFatalNetworkError = /ERR_NAME_NOT_RESOLVED|ERR_SSL_PROTOCOL_ERROR|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_CERT_AUTHORITY_INVALID/i.test(err.message);
    if (isFatalNetworkError) {
      logger.info(`接続エラーにつき除外: "${err.message}" → ${url}`);
      return { active: false, reason: `接続不可 (${err.message})` };
    }
    // その他のエラー（タイムアウト・ERR_BLOCKED_BY_CLIENT 等）は除外する
    // 検証できないURLを通知すると誤通知の温床になるため、信頼できない場合は通知しない方針
    logger.info(`空室なし除外: 取得失敗 "${err.message}" → ${url}`);
    return { active: false, reason: `ページ取得失敗 (${err.message})` };
  }
}

// ================================================================
// URL 正規化 & ポータルサイト除外
// ================================================================

function filterPortalUrls(urls, excludeDomains) {
  if (!excludeDomains || excludeDomains.length === 0) return urls;
  return urls.filter(url => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return !excludeDomains.some(d => host === d || host.endsWith('.' + d));
    } catch { return true; }
  });
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.protocol = 'https:';
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
     'gclid','fbclid','msclkid','_ga','mc_cid','mc_eid']
      .forEach(p => u.searchParams.delete(p));
    u.search = new URLSearchParams([...u.searchParams].sort()).toString();
    if (!u.search && !u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
  } catch { return url; }
}

// ================================================================
// Discord 通知（1ビル = 1メッセージ）
// ================================================================

async function sendDiscordNotification(newItems, webhookUrl) {
  for (const item of newItems) {
    const urlFields = item.urls.slice(0, 10).map((url, i) => ({
      name: `物件 ${i + 1}`,
      value: url.length > 200 ? url.slice(0, 200) + '…' : url,
      inline: false,
    }));

    const payload = {
      username: 'レンタルスペース監視Bot',
      embeds: [{
        title: `🏢 新着: ${item.name}`,
        description: `${item.address}${item.building ? ' ' + item.building : ''}`,
        color: 0x00ff00,
        fields: urlFields,
        timestamp: new Date().toISOString(),
      }],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord通知失敗: ${res.status} ${await res.text()}`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ================================================================
// メイン
// ================================================================

// 並列ジョブ分割（BATCH_INDEX: 0始まりのジョブ番号, BATCH_TOTAL: 総ジョブ数）
const batchIndex = parseInt(process.env.BATCH_INDEX ?? '0', 10);
const batchTotal = parseInt(process.env.BATCH_TOTAL ?? '1', 10);

// 月間予算から「1回の実行で処理できる上限件数」を計算
// 1日 batchTotal 回 × 30日 実行する前提で、1回あたりの予算を逆算する。
const MONTHLY_BUDGET_MIN  = 2000;  // GitHub Actions 無料枠（分/月）
const SETUP_OVERHEAD_MIN  = 4;     // 1回あたりのセットアップ所要時間（分）
const SEC_PER_ITEM_EST    = 22;    // 1件あたりの推定処理時間（秒）
const PER_RUN_MAX = Math.floor(
  ((MONTHLY_BUDGET_MIN / 30 / batchTotal) - SETUP_OVERHEAD_MIN) * 60 / SEC_PER_ITEM_EST
); // batchTotal=3 → ≈ 49件/回

async function main() {
  const startTime = Date.now();
  logger.info('処理開始');

  const config = loadConfig();
  const {
    discordWebhookUrl, spreadsheetId,
    geminiApiKey, serviceAccountKeyPath,
    searchDelay = 2000, maxKnownUrls = 50,
  } = config;
  logger.info(`除外ドメイン数: ${(config.excludePortalDomains || []).length}件`);

  // Google Sheets クライアント
  const sheets = await getSheetsClient(serviceAccountKeyPath);
  const fullList = await loadMonitoringList(sheets, spreadsheetId);
  logger.info(`スプレッドシート読み込み: ${fullList.length}件`);

  // 最終チェックが古い順にソートし、予算内件数だけ処理
  fullList.sort((a, b) => {
    if (!a.lastCheckRaw && !b.lastCheckRaw) return 0;
    if (!a.lastCheckRaw) return -1;
    if (!b.lastCheckRaw) return 1;
    return new Date(a.lastCheckRaw) - new Date(b.lastCheckRaw);
  });
  // 1回あたりの処理件数 = 全件を batchTotal 回に分けた数（予算上限で頭打ち）
  // ソートは「最終チェックが古い順」なので、毎回先頭から chunkSize 件取れば
  // タイムスタンプのローテーションで自然に全件を巡回する（実行失敗時も自己修復）。
  const idealChunk     = Math.ceil(fullList.length / batchTotal);
  const chunkSize      = Math.min(idealChunk, PER_RUN_MAX);
  const budgetCapped   = idealChunk > PER_RUN_MAX;
  const monitoringList = fullList.slice(0, chunkSize);
  logger.info(`ジョブ${batchIndex + 1}/${batchTotal}: 最古${monitoringList.length}件を処理 / 全${fullList.length}件`);

  // Gemini モデル
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  // Puppeteer 起動
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--no-first-run','--no-default-browser-check','--disable-extensions','--lang=ja'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const allNewItems = [];

  for (const item of monitoringList) {
    const query = [item.address, item.building, '賃貸'].filter(Boolean).join(' ');

    // 検索
    const foundUrls      = await search(query, page);
    const normalizedUrls = [...new Set(foundUrls.map(normalizeUrl))];

    // ポータルサイト除外（スペースマーケット等の時間貸しサイトを弾く）
    const portalFiltered = filterPortalUrls(normalizedUrls, config.excludePortalDomains);
    if (normalizedUrls.length !== portalFiltered.length) {
      const dropped = normalizedUrls.filter(u => !portalFiltered.includes(u));
      logger.info(`ポータル除外 ${dropped.length}件: ${dropped.join(', ')}`);
    }

    // 一次フィルタ（文字列比較）
    const knownSet    = new Set(item.knownUrls);
    const candidates  = portalFiltered.filter(u => !knownSet.has(u));

    // Gemini 二次判定（候補がある場合のみ）
    let trulyNew = [];
    if (candidates.length > 0) {
      trulyNew = await judgeNewUrls(model, item, candidates);
      // Tier 1 は 4,000 RPM 上限。スパイク防止に 1 秒だけ間を空ける。
      await new Promise(r => setTimeout(r, 1000));
    }

    // Puppeteer 三次判定：空室確認（ページ内容でNGキーワードチェック）
    if (trulyNew.length > 0) {
      const checked = [];
      for (const url of trulyNew) {
        const { active, reason } = await checkVacancyActive(url, item, page);
        if (active) {
          checked.push(url);
        } else {
          logger.info(`空室なし除外: "${reason}" 検出 → ${url}`);
        }
      }
      trulyNew = checked;
    }

    logger.info(`"${item.name}" 検索:${foundUrls.length}件 除外後:${portalFiltered.length}件 候補:${candidates.length}件 新着:${trulyNew.length}件`);

    if (trulyNew.length > 0) {
      allNewItems.push({ name: item.name, address: item.address, building: item.building, urls: trulyNew });
    }

    // ポータル除外ドメインに一致するものを既知リストからもクリーンアップする
    const cleanedKnownUrls = filterPortalUrls(item.knownUrls, config.excludePortalDomains);

    // 処理完了ごとに即時スプシ更新（重複を排除し、最大保持数に切り詰める）
    const updatedKnownUrls = [...new Set([...cleanedKnownUrls, ...trulyNew])].slice(-maxKnownUrls);
    await updateSheet(sheets, spreadsheetId, [{
      sheetRow:  item.sheetRow,
      knownUrls: updatedKnownUrls.join(', '),
      lastCheck: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      hitCount:  foundUrls.length,
    }]);

    await new Promise(r => setTimeout(r, searchDelay));
  }

  // Discord 通知（新着物件）
  if (allNewItems.length > 0) {
    logger.info(`新着${allNewItems.length}件 → Discord通知送信`);
    try {
      await sendDiscordNotification(allNewItems, discordWebhookUrl);
      logger.info(`Discord通知完了`);
    } catch (err) {
      logger.error(`Discord通知失敗: ${err.message}`);
    }
  } else {
    logger.info(`新着なし、通知スキップ`);
  }

  logger.info(`スプレッドシート更新完了（逐次）`);

  await browser.close();
  logger.info(`処理完了: 新着合計${allNewItems.length}件`);

  // 実行完了レポート（新着の有無に関わらず毎回送信）
  try {
    const elapsedMin           = (Date.now() - startTime) / 60000;

    const dailyCoverage = chunkSize * batchTotal; // 1日(全batch)で処理できる件数
    const warnings = [];
    if (budgetCapped && dailyCoverage < fullList.length) {
      const carryOver = fullList.length - dailyCoverage;
      warnings.push(`⚠️ 1日で全件未達: 1日${dailyCoverage}件処理（全${fullList.length}件、${carryOver}件は翌日繰越）`);
    }

    const lines = [
      `ジョブ: ${batchIndex + 1}/${batchTotal}`,
      `処理件数: 最古${monitoringList.length}件 / 全${fullList.length}件`,
      `新着: ${allNewItems.length}件`,
      `実行時間: ${elapsedMin.toFixed(1)}分`,
      ...warnings,
    ];

    const color = warnings.length > 0 ? 0xff9900
                : allNewItems.length > 0 ? 0x00ff00
                : 0x808080;

    await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'レンタルスペース監視Bot',
        embeds: [{
          title: warnings.length > 0 ? '⚠️ 監視実行完了（要確認）' : '✅ 監視実行完了',
          description: lines.join('\n'),
          color,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (err) {
    logger.error(`完了レポート通知失敗: ${err.message}`);
  }
}

main().catch(err => {
  logger.error(`起動エラー: ${err.message}`);
  process.exit(1);
});
