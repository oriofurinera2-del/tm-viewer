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

test('ログインスクリプトはパスワード欄を含む form を探して送信する組み立て', () => {
  const script = buildLoginScript('id', 'password');
  assert.equal(script.includes('input[type="password"]'), true);
  assert.equal(script.includes('requestSubmit'), true);
});
