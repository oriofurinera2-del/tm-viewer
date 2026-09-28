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
// 8 章の実測どおり、ページには 2 つの form がある（上部メニューの簡易フォームと本体フォーム）。
// 本体フォームだけに「記憶する」チェック input[name="login_remember"] があるので、
// これを含む form を対象にする（簡易フォームを誤って埋めないため）。
// 見つからない場合のみ、password 欄を含み action が /login な form にフォールバックする。
// 欄は input[name="username"]・input[name="password"]、送信は button[name="submit_login"]（無ければ form の submit）。
// 戻り値（true/false）で「入力・送信できたか」だけを main 側に伝え、成否の最終判定は
// 送信後のページがまだログイン画面かどうかで行う（呼び出し側）。
function buildLoginScript(id, password) {
  return `(() => {
  try {
    const forms = Array.from(document.querySelectorAll('form'));
    let form = forms.find(f => f.querySelector('input[name="login_remember"]'));
    if (!form) {
      form = forms.find(f => f.querySelector('input[type="password"]')
        && (f.getAttribute('action') || '').indexOf('/login') !== -1);
    }
    if (!form) return false;
    const idInput = form.querySelector('input[name="username"]');
    const passwordInput = form.querySelector('input[name="password"]');
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
    const rememberInput = form.querySelector('input[name="login_remember"]');
    if (rememberInput && !rememberInput.checked) {
      rememberInput.checked = true;
      rememberInput.dispatchEvent(new Event('input', { bubbles: true }));
      rememberInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const submitButton = form.querySelector('button[name="submit_login"]');
    if (submitButton) submitButton.click();
    else if (typeof form.requestSubmit === 'function') form.requestSubmit();
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
