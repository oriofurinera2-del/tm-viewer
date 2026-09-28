'use strict';

// サイトの HTML を読むのはこのファイルだけ。サイトの形が変わったら、まず下の定数を直す。
// どの関数も読めないときは例外を投げず、空配列・null・lastPage 1 を返す。

const cheerio = require('cheerio');

// --- サイトの形に依存する知識（DESIGN 8 章で確認済み） ---

// 自分の名前: ヘッダーのドロップダウンと、そのメニュー内の /user/<自分>/videos
const ME_TOGGLE_SELECTOR = 'a.dropdown-toggle';
const ME_MENU_LINK_SELECTOR = '.dropdown-menu a[href]';
const ME_VIDEOS_PATH = /^\/user\/([^/?#]+)\/videos\/?$/;

// フレンド一覧・購読一覧: 各人の枠と、その中のプロフィールへのリンク。
// 同じ枠にある「削除」ボタン（#remove_…）は読まない。
const USER_ITEM_SELECTOR = 'div[id^="friend_"], div[id^="subscription_"]';
const USER_ITEM_ID = /^(friend|subscription)_\d+$/;
const USER_LINK_SELECTOR = 'a[href^="/user/"]';
const USER_PROFILE_PATH = /^\/user\/([^/?#]+)\/?$/;
// 各人のアイコン: 同じ枠の img の src（プロフィールへのリンクの中にある）
const USER_AVATAR_SELECTOR = 'img[src]';

// 動画一覧: 各動画の枠と中身
const VIDEO_ITEM_SELECTOR = 'div[id^="video_"]';
const VIDEO_ITEM_ID = /^video_(\d+)$/;
const VIDEO_TITLE_SELECTOR = '.video-title';
const VIDEO_DURATION_SELECTOR = '.duration';
const VIDEO_HD_SELECTOR = '.hd-text-icon';
const VIDEO_PRIVATE_SELECTOR = '.label-private';
const VIDEO_ADDED_SELECTOR = '.video-added';
const VIDEO_THUMB_SELECTOR = 'img';

// ページ送り: リンクの ?page=N と、現在ページ（li.active）
const PAGINATION_LINK_SELECTOR = '.pagination a[href]';
const PAGINATION_ACTIVE_SELECTOR = '.pagination li.active';
const PAGE_PARAM = /[?&]page=(\d+)/;

// 総数の一文: 「公開中 1 へ 18 の 686 ビデオ.」「… の 61 友達.」「… の 7 subscriptions.」
const TOTAL_SENTENCE = /公開中\s*[\d,]+\s*へ\s*[\d,]+\s*の\s*([\d,]+)/;

// サイト自身の絶対 URL（相対パスに直して比べる）
const SITE_ORIGIN = /^https?:\/\/(?:www\.)?tokyomotion\.net(?=\/)/i;
const SITE_BASE_URL = 'https://www.tokyomotion.net/';

// タグ（K2 で確定、DESIGN 8 章）: POST /ajax/video_tag の応答は JSON {"status":0,"msg":"<HTML>"}。
// タグは msg の中の a.tag のテキスト。同じ msg にある投票ボタン（tagvp）は読まない。
const TAG_MESSAGE_KEY = 'msg';
const TAG_LINK_SELECTOR = 'a.tag';

// Google 検索の結果（試作）: 結果の見出しを含むリンクだけから動画ページを拾う。
// Google の内部ページ・広告・一般リンクは受け入れない。
const GOOGLE_RESULT_AREA_SELECTOR = '#search, #rso';
const GOOGLE_RESULT_LINK_SELECTOR = 'a[href]';
const GOOGLE_RESULT_TITLE_SELECTOR = 'h3';
const GOOGLE_SEARCH_FORM_SELECTOR = 'form[action="/search"]';
const GOOGLE_BASE_URL = 'https://www.google.com/';

// --- 共通 ---

function load(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  try {
    return cheerio.load(html);
  } catch {
    return null;
  }
}

// 画像の src を http(s) の絶対 URL にする。空・その他の形は null。
function absoluteUrl(src) {
  const value = cleanText(src);
  if (!value) return null;
  try {
    const url = new URL(value, SITE_BASE_URL);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function sitePath(href) {
  if (typeof href !== 'string') return '';
  return href.trim().replace(SITE_ORIGIN, '');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toInt(value) {
  const number = Number.parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isFinite(number) ? number : null;
}

function readLastPage($) {
  let last = 1;
  $(PAGINATION_LINK_SELECTOR).each((_, el) => {
    const match = PAGE_PARAM.exec($(el).attr('href') || '');
    const page = match ? toInt(match[1]) : null;
    if (page && page > last) last = page;
  });
  $(PAGINATION_ACTIVE_SELECTOR).each((_, el) => {
    const page = toInt(cleanText($(el).text()));
    if (page && page > last) last = page;
  });
  return last;
}

function readTotal($) {
  const match = TOTAL_SENTENCE.exec(cleanText($.root().text()));
  return match ? toInt(match[1]) : null;
}

// --- 公開する関数（HANDOFF 3 章の約束） ---

function parseMe(html) {
  const $ = load(html);
  if (!$) return null;
  let me = null;
  $(ME_TOGGLE_SELECTOR).each((_, toggle) => {
    if (me) return false;
    $(toggle).parent().find(ME_MENU_LINK_SELECTOR).each((__, link) => {
      const match = ME_VIDEOS_PATH.exec(sitePath($(link).attr('href')));
      if (match) {
        me = safeDecode(match[1]);
        return false;
      }
      return undefined;
    });
    return undefined;
  });
  return me;
}

// avatars は { 名前: アイコンの URL }。src が空の人は入れない。
function parseUserList(html) {
  const $ = load(html);
  if (!$) return { users: [], avatars: {}, lastPage: 1, total: null };
  const me = parseMe(html);
  const users = [];
  const avatars = {};
  const seen = new Set();
  $(USER_ITEM_SELECTOR).each((_, item) => {
    if (!USER_ITEM_ID.test($(item).attr('id') || '')) return;
    const names = [];
    $(item).find(USER_LINK_SELECTOR).each((__, link) => {
      const match = USER_PROFILE_PATH.exec(sitePath($(link).attr('href')));
      if (!match) return;
      const name = safeDecode(match[1]);
      if (name === me || names.includes(name)) return;
      names.push(name);
      if (seen.has(name)) return;
      seen.add(name);
      users.push(name);
    });
    // 1 つの枠に 1 人のときだけアイコンを結び付ける（取り違えを防ぐ）
    if (names.length !== 1 || avatars[names[0]]) return;
    $(item).find(USER_AVATAR_SELECTOR).each((__, img) => {
      const url = absoluteUrl($(img).attr('src'));
      if (url) {
        avatars[names[0]] = url;
        return false;
      }
      return undefined;
    });
  });
  return { users, avatars, lastPage: readLastPage($), total: readTotal($) };
}

function parseVideoList(html) {
  const $ = load(html);
  if (!$) return { videos: [], lastPage: 1, total: null };
  const videos = [];
  const seen = new Set();
  $(VIDEO_ITEM_SELECTOR).each((_, item) => {
    const $item = $(item);
    const match = VIDEO_ITEM_ID.exec($item.attr('id') || '');
    if (!match) return;
    const id = toInt(match[1]);
    if (id === null || seen.has(id)) return;
    seen.add(id);
    const $img = $item.find(VIDEO_THUMB_SELECTOR).first();
    const title = cleanText($item.find(VIDEO_TITLE_SELECTOR).first().text())
      || cleanText($img.attr('alt'));
    const thumb = cleanText($img.attr('src'));
    videos.push({
      id,
      title,
      duration: cleanText($item.find(VIDEO_DURATION_SELECTOR).first().text()),
      hd: $item.find(VIDEO_HD_SELECTOR).length > 0,
      private: $item.find(VIDEO_PRIVATE_SELECTOR).length > 0,
      thumb: thumb || null,
      ago: cleanText($item.find(VIDEO_ADDED_SELECTOR).first().text()),
    });
  });
  return { videos, lastPage: readLastPage($), total: readTotal($) };
}

function parseVideoTags(body) {
  if (typeof body !== 'string') return [];
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  const $ = load(data && typeof data === 'object' ? data[TAG_MESSAGE_KEY] : null);
  if (!$) return [];
  const tags = [];
  $(TAG_LINK_SELECTOR).each((_, el) => {
    const name = cleanText($(el).text());
    if (name && !tags.includes(name)) tags.push(name);
  });
  return tags;
}

// Google の検索結果は保存せず、その場で動画ページの URL とタイトルだけを返す。
// null は CAPTCHA・同意画面など、検索結果として読めない HTML を示す。
function parseGoogleSearchResults(html) {
  const $ = load(html);
  if (!$ || $(GOOGLE_RESULT_AREA_SELECTOR).length === 0 || $(GOOGLE_SEARCH_FORM_SELECTOR).length === 0) return null;
  const results = [];
  const seen = new Set();
  $(GOOGLE_RESULT_AREA_SELECTOR).find(GOOGLE_RESULT_LINK_SELECTOR).each((_, link) => {
    const $link = $(link);
    const title = cleanText($link.find(GOOGLE_RESULT_TITLE_SELECTOR).first().text());
    if (!title) return;
    const result = googleVideoUrl($link.attr('href'));
    if (!result || seen.has(result.id)) return;
    seen.add(result.id);
    results.push({ ...result, title });
  });
  return results;
}

function googleVideoUrl(href) {
  if (typeof href !== 'string' || !href.trim()) return null;
  let url;
  try {
    url = new URL(href, GOOGLE_BASE_URL);
    if (url.hostname.toLowerCase() === 'www.google.com' && url.pathname === '/url') {
      url = new URL(url.searchParams.get('q') || '');
    }
  } catch {
    return null;
  }
  if (!['tokyomotion.net', 'www.tokyomotion.net'].includes(url.hostname.toLowerCase())) return null;
  const match = /^\/video\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  const id = toInt(match[1]);
  if (id === null) return null;
  return { id, url: `https://www.tokyomotion.net/video/${id}` };
}

module.exports = {
  parseGoogleSearchResults,
  parseMe,
  parseUserList,
  parseVideoList,
  parseVideoTags,
};
