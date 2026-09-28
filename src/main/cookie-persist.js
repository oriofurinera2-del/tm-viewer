'use strict';

// セッション Cookie の永続化（DESIGN 4.1「ログイン情報の保存」の背景）。
// サイトのログイン Cookie は有効期限のない「セッション Cookie」で、Electron の persist
// セッションは再起動時にこれを破棄する（Chrome は復元する）。アプリ終了時に、対象の
// セッション Cookie を遠い未来の有効期限付きで書き戻し、ログインを保持する。
// ここは純粋関数だけを置く。実際の session.cookies.get/set は main.js から呼ぶ。

// 対象ドメイン（credentials.js の SITE_HOSTS・session.js の SITE_HOSTS に合わせる。
// CDN 側の tokyo-motion.net も Cookie を持ちうるため含める）。
const TOKYOMOTION_DOMAINS = ['tokyomotion.net', 'tokyo-motion.net'];

function hostFromDomain(domain) {
  if (typeof domain !== 'string' || !domain) return '';
  return domain.startsWith('.') ? domain.slice(1) : domain;
}

function isTokyoMotionDomain(domain) {
  const host = hostFromDomain(domain).toLowerCase();
  if (!host) return false;
  return TOKYOMOTION_DOMAINS.some(base => host === base || host.endsWith(`.${base}`));
}

// 「セッション Cookie」= 有効期限が付いていない Cookie。Electron の Cookie オブジェクトは
// session === true、または expirationDate が無い（undefined）ことで示す。
function isSessionCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return false;
  if (cookie.session === true) return true;
  return cookie.expirationDate === undefined || cookie.expirationDate === null;
}

// Cookie を session.cookies.set にそのまま渡せる形にする。
// url は domain・path・secure から組み立てる（先頭ドットの domain はホスト部分から外す）。
function toSetDetails(cookie, expirationDate) {
  const host = hostFromDomain(cookie.domain);
  const protocol = cookie.secure ? 'https' : 'http';
  const cookiePath = cookie.path || '/';
  const url = `${protocol}://${host}${cookiePath}`;
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookiePath,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite,
    expirationDate
  };
}

// cookies: session.cookies.get({}) の戻り値。
// now: 現在時刻（ミリ秒、Date.now()）。
// farFutureMs: now に足す猶予（ミリ秒）。結果は Electron の expirationDate（UNIX 秒）に変換する。
// options.tokyoMotionOnly: true のとき tokyomotion.net 系ドメインの Cookie だけを対象にする。
function persistableCookies(cookies, now, farFutureMs, options = {}) {
  const list = Array.isArray(cookies) ? cookies : [];
  const { tokyoMotionOnly = false } = options || {};
  const baseNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const offset = typeof farFutureMs === 'number' && Number.isFinite(farFutureMs) ? farFutureMs : 0;
  const expirationDate = Math.floor((baseNow + offset) / 1000);

  return list
    .filter(cookie => isSessionCookie(cookie))
    .filter(cookie => !tokyoMotionOnly || isTokyoMotionDomain(cookie.domain))
    .map(cookie => toSetDetails(cookie, expirationDate));
}

module.exports = {
  TOKYOMOTION_DOMAINS,
  isSessionCookie,
  isTokyoMotionDomain,
  persistableCookies
};
