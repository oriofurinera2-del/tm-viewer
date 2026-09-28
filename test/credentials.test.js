'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FILE_NAME,
  credentialsPath,
  hasSaved,
  isAvailable,
  save,
  load,
  clear,
  isLoginUrl,
  buildLoginScript
} = require('../src/main/credentials');

// safeStorage の代わり。実際の DPAPI は使わず、Base64 で仮の「暗号化」をする。
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64'), 'utf8'),
    decryptString: buffer => Buffer.from(Buffer.from(buffer).toString('utf8'), 'base64').toString('utf8')
  };
}

function temporaryDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-viewer-credentials-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('settings.json とは別ファイル（credentials.bin）に保存する', t => {
  const dir = temporaryDir(t);
  assert.equal(path.basename(credentialsPath(dir)), 'credentials.bin');
  assert.equal(FILE_NAME, 'credentials.bin');
});

test('safeStorage が使えないときは isAvailable が false', () => {
  assert.equal(isAvailable(fakeSafeStorage({ available: false })), false);
  assert.equal(isAvailable(fakeSafeStorage({ available: true })), true);
  assert.equal(isAvailable(null), false);
  assert.equal(isAvailable(undefined), false);
});

test('保存して読み戻すと同じ id・password が取れる', t => {
  const dir = temporaryDir(t);
  const safeStorage = fakeSafeStorage();
  assert.equal(hasSaved(dir), false);

  save(dir, safeStorage, 'my-id', 'my-password');

  assert.equal(hasSaved(dir), true);
  assert.deepEqual(load(dir, safeStorage), { id: 'my-id', password: 'my-password' });
});

test('保存したファイルはそのまま JSON ではない（Base64 の「暗号化」を通している）', t => {
  const dir = temporaryDir(t);
  save(dir, fakeSafeStorage(), 'my-id', 'super-secret');
  const raw = fs.readFileSync(credentialsPath(dir), 'utf8');
  assert.equal(raw.includes('super-secret'), false);
});

test('id・password が空のときは保存しない', t => {
  const dir = temporaryDir(t);
  const safeStorage = fakeSafeStorage();
  assert.throws(() => save(dir, safeStorage, '', 'password'));
  assert.throws(() => save(dir, safeStorage, 'id', ''));
  assert.equal(hasSaved(dir), false);
});

test('ファイルが無い・壊れている・復号できないときは例外を投げず null', t => {
  const dir = temporaryDir(t);
  const safeStorage = fakeSafeStorage();
  assert.equal(load(dir, safeStorage), null);

  fs.writeFileSync(credentialsPath(dir), 'not encrypted data');
  assert.equal(load(dir, safeStorage), null);

  save(dir, safeStorage, 'id', 'password');
  const otherUser = { ...safeStorage, decryptString: () => { throw new Error('別の Windows ユーザーでは復号できない'); } };
  assert.equal(load(dir, otherUser), null);
});

test('削除すると読み戻せなくなる。無い状態で呼んでも例外にならない', t => {
  const dir = temporaryDir(t);
  const safeStorage = fakeSafeStorage();
  save(dir, safeStorage, 'id', 'password');
  clear(dir);
  assert.equal(hasSaved(dir), false);
  assert.equal(load(dir, safeStorage), null);
  clear(dir); // 既に無い
});

test('サイト本体のログイン画面だけ isLoginUrl が true', () => {
  assert.equal(isLoginUrl('https://www.tokyomotion.net/login'), true);
  assert.equal(isLoginUrl('https://tokyomotion.net/login'), true);
  assert.equal(isLoginUrl('https://tokyomotion.net/login/'), true);
  assert.equal(isLoginUrl('https://www.tokyomotion.net/'), false);
  assert.equal(isLoginUrl('https://www.tokyomotion.net/video/123'), false);
  assert.equal(isLoginUrl('https://evil.example/login'), false);
  assert.equal(isLoginUrl('https://tokyomotion.net.evil.example/login'), false);
  assert.equal(isLoginUrl('not a url'), false);
});

test('ログインスクリプトは id・password を JSON.stringify で埋め込み、そのまま連結しない', () => {
  const script = buildLoginScript('my"id', "pass'word\\<>");
  assert.equal(script.includes(JSON.stringify('my"id')), true);
  assert.equal(script.includes(JSON.stringify("pass'word\\<>")), true);
  // 構文として valid（Function コンストラクタで解析できる＝壊れていない）
  assert.doesNotThrow(() => new Function(`return ${script}`));
});

test('ログインスクリプトは login_remember を含む本体フォームを対象にし、username/password/submit_login を使う組み立て', () => {
  const script = buildLoginScript('id', 'password');
  assert.equal(script.includes('input[name="login_remember"]'), true);
  assert.equal(script.includes('input[name="username"]'), true);
  assert.equal(script.includes('input[name="password"]'), true);
  assert.equal(script.includes('button[name="submit_login"]'), true);
  assert.equal(script.includes('requestSubmit'), true); // フォールバック
});

// jsdom 等は使わず、8 章の実測に沿った最小限の DOM 相当オブジェクトをその場で組み立てて
// buildLoginScript の戻り値（文字列）を実際に評価し、正しい form が選ばれることを検証する。
function fakeInput(name, type) {
  return { name, type, value: '', checked: false, listeners: [], dispatchEvent(e) { this.listeners.push(e.type); } };
}
function fakeForm({ action, hasRemember, hasSubmitButton }) {
  const username = fakeInput('username', 'text');
  const password = fakeInput('password', 'password');
  const remember = hasRemember ? { ...fakeInput('login_remember', 'checkbox') } : null;
  const submitButton = hasSubmitButton ? { name: 'submit_login', clicked: false, click() { this.clicked = true; } } : null;
  const fields = [username, password, remember, submitButton].filter(Boolean);
  return {
    action,
    requestSubmitCalled: false,
    getAttribute(attr) { return attr === 'action' ? this.action : null; },
    querySelector(sel) {
      if (sel === 'input[name="login_remember"]') return remember;
      if (sel === 'input[name="username"]') return username;
      if (sel === 'input[name="password"]') return password;
      if (sel === 'input[type="password"]') return password;
      if (sel === 'button[name="submit_login"]') return submitButton;
      return null;
    },
    requestSubmit() { this.requestSubmitCalled = true; },
    _fields: { username, password, remember, submitButton }
  };
}
function runScript(script, forms) {
  const fakeDocument = { querySelectorAll: sel => (sel === 'form' ? forms : []) };
  const fakeWindow = { Event: function Event(type) { this.type = type; } };
  const fn = new Function('document', 'Object', 'Event', `return ${script}`);
  const result = fn(fakeDocument, Object, fakeWindow.Event);
  return result;
}

test('ログインスクリプトは、上部メニューの簡易フォーム（login_remember なし）ではなく本体フォームを選ぶ', () => {
  const quick = fakeForm({ action: '/login', hasRemember: false, hasSubmitButton: true });
  const main = fakeForm({ action: '/login', hasRemember: true, hasSubmitButton: true });
  const script = buildLoginScript('my-id', 'my-password');
  const result = runScript(script, [quick, main]);
  assert.equal(result, true);
  assert.equal(main._fields.username.value, 'my-id');
  assert.equal(main._fields.password.value, 'my-password');
  assert.equal(main._fields.remember.checked, true);
  assert.equal(main._fields.submitButton.clicked, true);
  assert.equal(quick._fields.username.value, ''); // 簡易フォームは埋めない
});

test('ログインスクリプトは login_remember が無いとき、password 欄と action=/login を持つ form にフォールバックする', () => {
  const only = fakeForm({ action: '/login', hasRemember: false, hasSubmitButton: false });
  const script = buildLoginScript('id2', 'password2');
  const result = runScript(script, [only]);
  assert.equal(result, true);
  assert.equal(only._fields.username.value, 'id2');
  assert.equal(only._fields.password.value, 'password2');
  assert.equal(only.requestSubmitCalled, true); // submit_login ボタンが無いのでフォールバック
});
