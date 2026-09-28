'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { persistableCookies, isSessionCookie, isTokyoMotionDomain } = require('../src/main/cookie-persist');

const NOW = Date.UTC(2026, 8, 29); // 2026-09-29 (ms)
const FAR_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function sessionCookie(overrides = {}) {
  return {
    name: 'PHPSESSID',
    value: 'abc123',
    domain: '.tokyomotion.net',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: true,
    ...overrides
  };
}

test('session === true の Cookie だけを選ぶ', () => {
  const persistentCookie = { ...sessionCookie({ name: 'persistent' }), session: false, expirationDate: 1234567890 };
  const result = persistableCookies([sessionCookie(), persistentCookie], NOW, FAR_FUTURE_MS);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'PHPSESSID');
});

test('expirationDate が無い Cookie もセッション Cookie として扱う', () => {
  const cookie = sessionCookie({ session: undefined, expirationDate: undefined });
  const result = persistableCookies([cookie], NOW, FAR_FUTURE_MS);
  assert.equal(result.length, 1);
  assert.equal(isSessionCookie(cookie), true);
});

test('既に有効期限が付いている（永続）Cookie は対象外', () => {
  const cookie = sessionCookie({ session: false, expirationDate: NOW / 1000 + 1000 });
  assert.equal(isSessionCookie(cookie), false);
  const result = persistableCookies([cookie], NOW, FAR_FUTURE_MS);
  assert.equal(result.length, 0);
});

test('遠い未来の expirationDate（UNIX 秒）を付けて session.cookies.set 用の形にする', () => {
  const result = persistableCookies([sessionCookie()], NOW, FAR_FUTURE_MS);
  assert.equal(result.length, 1);
  const details = result[0];
  const expected = Math.floor((NOW + FAR_FUTURE_MS) / 1000);
  assert.equal(details.expirationDate, expected);
  assert.ok(details.expirationDate > NOW / 1000 + 60 * 60 * 24 * 365 * 5); // 5年以上先
  assert.equal(details.url, 'https://tokyomotion.net/');
  assert.equal(details.domain, '.tokyomotion.net');
  assert.equal(details.name, 'PHPSESSID');
  assert.equal(details.value, 'abc123');
  assert.equal(details.secure, true);
  assert.equal(details.httpOnly, true);
  assert.equal(details.sameSite, 'lax');
});

test('secure でない Cookie は http の url を組み立てる', () => {
  const cookie = sessionCookie({ domain: 'www.tokyomotion.net', secure: false, path: '/foo' });
  const result = persistableCookies([cookie], NOW, FAR_FUTURE_MS);
  assert.equal(result[0].url, 'http://www.tokyomotion.net/foo');
});

test('tokyoMotionOnly オプションで tokyomotion 系以外のドメインを除外する', () => {
  const own = sessionCookie({ domain: '.tokyomotion.net' });
  const cdn = sessionCookie({ name: 'cdn', domain: 'cdn.tokyo-motion.net' });
  const other = sessionCookie({ name: 'other', domain: 'example.com' });

  const withoutFilter = persistableCookies([own, cdn, other], NOW, FAR_FUTURE_MS);
  assert.equal(withoutFilter.length, 3);

  const withFilter = persistableCookies([own, cdn, other], NOW, FAR_FUTURE_MS, { tokyoMotionOnly: true });
  const names = withFilter.map(c => c.name).sort();
  assert.deepEqual(names, ['PHPSESSID', 'cdn']);
});

test('isTokyoMotionDomain はサブドメインを含み、無関係なドメインを除く', () => {
  assert.equal(isTokyoMotionDomain('tokyomotion.net'), true);
  assert.equal(isTokyoMotionDomain('.tokyomotion.net'), true);
  assert.equal(isTokyoMotionDomain('www.tokyomotion.net'), true);
  assert.equal(isTokyoMotionDomain('cdn.tokyo-motion.net'), true);
  assert.equal(isTokyoMotionDomain('tokyomotion.net.evil.example'), false);
  assert.equal(isTokyoMotionDomain('example.com'), false);
  assert.equal(isTokyoMotionDomain(''), false);
});

test('空配列・不正な入力でも例外を投げない', () => {
  assert.deepEqual(persistableCookies([], NOW, FAR_FUTURE_MS), []);
  assert.deepEqual(persistableCookies(undefined, NOW, FAR_FUTURE_MS), []);
});
