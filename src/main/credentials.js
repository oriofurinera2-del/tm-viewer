'use strict';

// ログイン情報の保存と自動ログイン（DESIGN 4.1・任意・初期値オフ）。
// 暗号化・復号はこのファイル（main プロセス）だけで行う。safeStorage は呼び出し元（main.js）から渡す。
// パスワードはここで組み立てるスクリプト文字列の中とファイルの中にしか出さない。ログ・画面・エラー文には出さない。

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'credentials.bin';
const SITE_HOSTS = new Set(['tokyomotion.net', 'www.tokyomotion.net']);
// サイトのログイン画面の URL。DESIGN 8 章に記載が無いため [要確認]（実サイトでの確認待ち）。
const LOGIN_PATH = /^\/login\/?$/i;

function credentialsPath(userDataPath) {
  return path.join(userDataPath, FILE_NAME);
}

function hasSaved(userDataPath) {
  try {
    return fs.existsSync(credentialsPath(userDataPath));
  } catch {
    return false;
  }
}

// safeStorage が使えるか（Windows の DPAPI）。使えない環境では設定自体を出さない（DESIGN 4.1）。
function isAvailable(safeStorage) {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

// { id, password } を JSON にして safeStorage で暗号化し、settings.json とは別ファイルに書く。
function save(userDataPath, safeStorage, id, password) {
  if (typeof id !== 'string' || !id || typeof password !== 'string' || !password) {
    throw new TypeError('IDとパスワードが必要です');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify({ id, password }));
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(credentialsPath(userDataPath), encrypted);
}

// 読めない・復号できないときは例外を投げず null を返す。
function load(userDataPath, safeStorage) {
  let encrypted;
  try {
    encrypted = fs.readFileSync(credentialsPath(userDataPath));
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(safeStorage.decryptString(encrypted));
    if (typeof payload?.id === 'string' && typeof payload?.password === 'string') return payload;
  } catch {
    /* 無視 */
  }
  return null;
}

// 設定をオフにしたとき・「保存した情報を削除」ボタンで使う。無ければ何もしない。
function clear(userDataPath) {
  try {
    fs.unlinkSync(credentialsPath(userDataPath));
  } catch {
    /* 既に無い場合も含め無視 */
  }
}

// ---- 自動ログイン ----

function isLoginUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (!SITE_HOSTS.has(url.hostname.toLowerCase())) return false;
    return LOGIN_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

// サイト表示のログイン画面へ入力して送信するスクリプト（webContents.executeJavaScript で実行）。
// 8 章にセレクタの確認が無いため、固定の input[name=...] ではなく
// 「パスワード欄を含む form」を探して、その中の ID/メール欄に入力する汎用的なやり方にしている。
// 実サイトで固定のセレクタが確認できたら、そちらに置き換えるほうが確実。
// 戻り値（true/false）で「入力・送信できたか」だけを main 側に伝え、成否の最終判定は
// 送信後のページがまだログイン画面かどうかで行う（呼び出し側）。
function buildLoginScript(id, password) {
  return `(() => {
  try {
    const form = Array.from(document.querySelectorAll('form'))
      .find(f => f.querySelector('input[type="password"]'));
    if (!form) return false;
    const passwordInput = form.querySelector('input[type="password"]');
    const idInput = form.querySelector('input[type="email"]')
      || form.querySelector('input[type="text"]')
      || form.querySelector('input[name*="user" i]')
      || form.querySelector('input[name*="login" i]')
      || form.querySelector('input[name*="email" i]');
    if (!idInput || !passwordInput) return false;
    const setValue = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue(idInput, ${JSON.stringify(id)});
    setValue(passwordInput, ${JSON.stringify(password)});
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
    return true;
  } catch (e) {
    return false;
  }
})()`;
}

module.exports = {
  FILE_NAME,
  credentialsPath,
  hasSaved,
  isAvailable,
  save,
  load,
  clear,
  isLoginUrl,
  buildLoginScript
};
