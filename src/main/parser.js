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

// タグ（K2 で確定）: HTML で返ってきた場合に拾うリンク
const TAG_LINK_SELECTOR = 'a[href*="/tag"], a[href*="/search"]';

// --- 共通 ---

function load(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  try {
    return cheerio.load(html);
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

function parseUserList(html) {
  const $ = load(html);
  if (!$) return { users: [], lastPage: 1, total: null };
  const me = parseMe(html);
  const users = [];
  const seen = new Set();
  $(USER_ITEM_SELECTOR).each((_, item) => {
    if (!USER_ITEM_ID.test($(item).attr('id') || '')) return;
    $(item).find(USER_LINK_SELECTOR).each((__, link) => {
      const match = USER_PROFILE_PATH.exec(sitePath($(link).attr('href')));
      if (!match) return;
      const name = safeDecode(match[1]);
      if (name === me || seen.has(name)) return;
      seen.add(name);
      users.push(name);
    });
  });
  return { users, lastPage: readLastPage($), total: readTotal($) };
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

// /ajax/video_tag の応答の形は未確認。K2 で確定する。
// 今は「JSON 配列 / JSON オブジェクトの tags 配列 / HTML 内のリンク文字列」を順に試す仮実装。
function tagName(value) {
  if (typeof value === 'string') return cleanText(value);
  if (value && typeof value === 'object') {
    return cleanText(value.name ?? value.tag ?? value.title ?? '');
  }
  return '';
}

function uniqueTags(values) {
  const tags = [];
  for (const value of values) {
    const name = tagName(value);
    if (name && !tags.includes(name)) tags.push(name);
  }
  return tags;
}

function parseVideoTags(body) {
  let data = body;
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return [];
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (data === null || typeof data !== 'object') {
      const $ = load(text);
      if (!$) return [];
      return uniqueTags($(TAG_LINK_SELECTOR).map((_, el) => $(el).text()).get());
    }
  }
  if (Array.isArray(data)) return uniqueTags(data);
  if (data && typeof data === 'object' && Array.isArray(data.tags)) return uniqueTags(data.tags);
  return [];
}

module.exports = {
  parseMe,
  parseUserList,
  parseVideoList,
  parseVideoTags,
};
