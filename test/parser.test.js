'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseMe,
  parseUserList,
  parseVideoList,
  parseVideoTags,
} = require('../src/main/parser');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

const UNRELATED_HTML = '<html><body><p>メンテナンス中です</p><a href="/user/someone">x</a></body></html>';

test('parseMe はメニューの /user/<自分>/videos から自分の名前を読む', () => {
  assert.equal(parseMe(fixture('friends.html')), 'my_name');
});

test('parseMe は自分のメニューが無ければ null', () => {
  assert.equal(parseMe(fixture('user-videos.html')), null);
  assert.equal(parseMe(fixture('subscriptions.html')), null);
  assert.equal(parseMe(''), null);
  assert.equal(parseMe(UNRELATED_HTML), null);
  assert.equal(parseMe(undefined), null);
});

test('parseUserList はフレンド一覧の名前・最後のページ・総数を読む', () => {
  const result = parseUserList(fixture('friends.html'));
  assert.deepEqual(result, {
    users: ['user01', 'user02', 'user03', 'user04'],
    lastPage: 4,
    total: 61,
  });
});

test('parseUserList は並び替えリンク・自分・削除ボタンを拾わない', () => {
  const { users } = parseUserList(fixture('friends.html'));
  assert.ok(!users.includes('my_name'));
  assert.ok(users.every(name => !name.includes('?') && !name.includes('remove')));
});

test('parseUserList は購読一覧を読み、ページ送りが無ければ lastPage 1', () => {
  assert.deepEqual(parseUserList(fixture('subscriptions.html')), {
    users: ['user01', 'user02', 'user03'],
    lastPage: 1,
    total: 7,
  });
});

test('parseUserList は同じ人を重複させない', () => {
  const html = `
    <div id="friend_1"><a href="/user/dup">dup</a><a href="/user/dup/">dup</a></div>
    <div id="subscription_2"><a href="https://www.tokyomotion.net/user/dup">dup</a><a href="/user/other">o</a></div>`;
  assert.deepEqual(parseUserList(html).users, ['dup', 'other']);
});

test('parseVideoList は 18 件・全部 PRIVATE・最後のページ 38・総数 686 を読む', () => {
  const { videos, lastPage, total } = parseVideoList(fixture('user-videos.html'));
  assert.equal(videos.length, 18);
  assert.equal(lastPage, 38);
  assert.equal(total, 686);
  assert.ok(videos.every(video => video.private === true));
  assert.ok(videos.every(video => Number.isInteger(video.id)));
  assert.deepEqual(videos[0], {
    id: 9000000,
    title: 'サンプル動画 1',
    duration: '01:55:52',
    hd: false,
    private: true,
    thumb: null,
    ago: '23 時 前',
  });
  assert.equal(videos[1].hd, true);
  assert.equal(videos[17].id, 8999371);
  assert.equal(videos[17].ago, '6 日 前');
});

test('parseVideoList は公開と PRIVATE を区別し、ページ送りが無ければ lastPage 1', () => {
  assert.deepEqual(parseVideoList(fixture('user-videos-mixed.html')), {
    videos: [
      {
        id: 7000500,
        title: 'サンプル動画 公開',
        duration: '52:54',
        hd: true,
        private: false,
        thumb: null,
        ago: '252 日 前',
      },
      {
        id: 7000400,
        title: 'サンプル動画 非公開',
        duration: '44:36',
        hd: true,
        private: true,
        thumb: null,
        ago: '245 日 前',
      },
    ],
    lastPage: 1,
    total: 2,
  });
});

test('parseVideoList はタイトルが空なら img の alt、src があればサムネに使う', () => {
  const html = `
    <div id="video_123"><img src="https://cdn.example.test/t.jpg" alt=" 代わりの題 ">
    <div class="video-title"> </div><div class="duration"> 1:00 </div></div>`;
  const [video] = parseVideoList(html).videos;
  assert.equal(video.id, 123);
  assert.equal(video.title, '代わりの題');
  assert.equal(video.thumb, 'https://cdn.example.test/t.jpg');
  assert.equal(video.duration, '1:00');
  assert.equal(video.ago, '');
});

test('読めない入力では例外を投げず空・null・lastPage 1 を返す', () => {
  for (const input of ['', UNRELATED_HTML, null, undefined, 42]) {
    assert.deepEqual(parseUserList(input), { users: [], lastPage: 1, total: null });
    assert.deepEqual(parseVideoList(input), { videos: [], lastPage: 1, total: null });
    assert.deepEqual(parseVideoTags(input), []);
  }
});

test('parseVideoTags は仮の形（JSON 配列・tags 配列・HTML のリンク）を読む', () => {
  assert.deepEqual(parseVideoTags('["a", "b", "a"]'), ['a', 'b']);
  assert.deepEqual(parseVideoTags('{"tags": [{"name": "x"}, "y"]}'), ['x', 'y']);
  assert.deepEqual(parseVideoTags({ tags: ['z'] }), ['z']);
  assert.deepEqual(
    parseVideoTags('<a href="/search?search_query=t1">t1</a> <a href="/tags/t2"> t2 </a>'),
    ['t1', 't2'],
  );
  assert.deepEqual(parseVideoTags('{"ok": true}'), []);
});
