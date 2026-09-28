'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  googleVideoUrl,
  parseGoogleNextPageHref,
  parseGoogleResultLinks,
  parseMe,
  parseUserList,
  parseVideoList,
  parseVideoPage,
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
    avatars: {},
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
    avatars: {},
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

test('parseUserList は各人の枠の img の src をアイコンとして返す', () => {
  const html = `
    <div id="friend_1"><a href="/user/alpha"><img src="https://cdn.example.test/a.jpg" alt=""></a>
      <a href="#remove_friend" id="remove_profile_friend_1">x</a></div>
    <div id="friend_2"><a href="/user/beta"><img src="" alt=""></a></div>
    <div id="subscription_3"><a href="/user/gamma"><img src="/media/avatars/g.jpg"></a></div>
    <div id="subscription_4"><a href="/user/delta"><img src="javascript:alert(1)"></a></div>`;
  assert.deepEqual(parseUserList(html), {
    users: ['alpha', 'beta', 'gamma', 'delta'],
    avatars: {
      alpha: 'https://cdn.example.test/a.jpg',
      gamma: 'https://www.tokyomotion.net/media/avatars/g.jpg',
    },
    lastPage: 1,
    total: null,
  });
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
    assert.deepEqual(parseUserList(input), { users: [], avatars: {}, lastPage: 1, total: null });
    assert.deepEqual(parseVideoList(input), { videos: [], lastPage: 1, total: null });
    assert.deepEqual(parseVideoTags(input), []);
  }
});

// /ajax/video_tag の応答の形（DESIGN 8 章）。タグ名は架空。
function tagResponse(msg) {
  return JSON.stringify({ status: 0, msg });
}

test('parseVideoTags は JSON の msg にある a.tag のテキストを読み、投票ボタンは無視する', () => {
  const msg = `
    <div class="tags">
      <a class="tag" href="/search?search_query=%E3%82%BF%E3%82%B0A&search_type=videos"> タグA </a>
      <a href="#" onclick="tagvp(1, 'up'); return false;"><i class="fa fa-thumbs-up"></i>1</a>
      <a class="tag" href="/search?search_query=tagB&search_type=videos">タグB</a>
      <a href="#" onclick="tagvp(2, 'down'); return false;">2</a>
      <a class="tag" href="/search?search_query=%E3%82%BF%E3%82%B0A">タグA</a>
      <a class="tag" href="/search?search_query="> </a>
    </div>`;
  assert.deepEqual(parseVideoTags(tagResponse(msg)), ['タグA', 'タグB']);
});

test('parseVideoTags は壊れた応答・タグ無しでは空配列', () => {
  for (const input of [
    '{"status":0,"msg":',
    '<a class="tag">タグA</a>',
    '["タグA"]',
    '{"status":0}',
    '{"status":0,"msg":""}',
    '{"status":0,"msg":42}',
    tagResponse('<p>タグはありません</p>'),
    'null',
    { status: 0, msg: '<a class="tag">タグA</a>' },
  ]) {
    assert.deepEqual(parseVideoTags(input), []);
  }
});

test('parseGoogleResultLinks は見出し付きのリンクを生 href＋タイトルで返す（id は解決しない）', () => {
  // href の形（直リンク・/url?q=平文・/goto?url=暗号化転送）はそのまま。解決は main 側。
  assert.deepEqual(parseGoogleResultLinks(fixture('google-search.html')), [
    { href: 'https://www.tokyomotion.net/video/101/example', title: '架空の結果 A' },
    { href: '/url?q=https%3A%2F%2Ftokyomotion.net%2Fvideo%2F202%2Fother', title: '架空の結果 B' },
    { href: '/goto?url=CAES-fake-encrypted-transfer-url', title: '架空の結果 C' },
    { href: 'https://example.test/video/303', title: '一般リンク' },
    { href: 'https://www.google.com/search?q=other', title: 'Google 内部ページ' },
    { href: 'https://www.tokyomotion.net/user/example', title: '動画以外' },
  ]);
});

test('parseGoogleResultLinks はコンテナに依存せず、見出し付きのリンクを拾う', () => {
  // 実際の Google はコンテナの id/class が変わる。h3 を持つリンクなら領域を問わず読む。
  const result = parseGoogleResultLinks(`
    <div><a href="/goto?url=CAES-abc"><h3>架空の結果</h3></a></div>`);
  assert.deepEqual(result, [{ href: '/goto?url=CAES-abc', title: '架空の結果' }]);
});

test('parseGoogleResultLinks は見出しの無いリンク（サムネ・引用元）を飛ばす', () => {
  const result = parseGoogleResultLinks(`
    <a href="/goto?url=CAES-thumb"><img></a>
    <a href="/goto?url=CAES-title"><h3>本命の見出し</h3></a>`);
  assert.deepEqual(result, [{ href: '/goto?url=CAES-title', title: '本命の見出し' }]);
});

test('parseGoogleResultLinks は同じ href の重複を軽く除く', () => {
  const result = parseGoogleResultLinks(`
    <a href="/goto?url=CAES-x"><h3>1つ目</h3></a>
    <a href="/goto?url=CAES-x"><h3>2つ目</h3></a>`);
  assert.deepEqual(result, [{ href: '/goto?url=CAES-x', title: '1つ目' }]);
});

test('parseGoogleResultLinks は見出し付きリンクが無ければ空配列', () => {
  assert.deepEqual(parseGoogleResultLinks('<div id="search"></div>'), []);
  assert.deepEqual(parseGoogleResultLinks('<a href="/goto?url=CAES-x"><img></a>'), []);
});

test('parseGoogleResultLinks は HTML として読めないものだけ null', () => {
  for (const input of ['', null, undefined]) {
    assert.equal(parseGoogleResultLinks(input), null);
  }
});

test('parseGoogleNextPageHref はページ内の a#pnnext の href を返し、無ければ null', () => {
  assert.equal(
    parseGoogleNextPageHref('<a id="pnnext" href="/search?q=x&start=10"><span>次へ</span></a>'),
    '/search?q=x&start=10'
  );
  assert.equal(parseGoogleNextPageHref('<a href="/search?q=x&start=10">次へ</a>'), null);
  assert.equal(parseGoogleNextPageHref('<div>結果なし</div>'), null);
  for (const input of ['', null, undefined]) assert.equal(parseGoogleNextPageHref(input), null);
});

test('parseVideoPage はサムネ img（/media/videos/）を優先し、無ければ og:image を使う', () => {
  const withThumb = `
    <html><head><meta property="og:image" content="https://cdn.tokyo-motion.net/og.jpg">
    <meta property="og:video:duration" content="6952"></head>
    <body><a href="/user/poster01">poster01</a>
    <img src="https://cdn.tokyo-motion.net/media/videos/tmb9/101/1.jpg"></body></html>`;
  assert.deepEqual(parseVideoPage(withThumb), {
    thumb: 'https://cdn.tokyo-motion.net/media/videos/tmb9/101/1.jpg',
    user: 'poster01',
    duration: '1:55:52'
  });
});

test('parseVideoPage はサムネ img が無ければ og:image、投稿者リンクが無ければ空', () => {
  const ogOnly = `
    <html><head><meta property="og:image" content="https://cdn.tokyo-motion.net/og.jpg"></head>
    <body><img src="https://cdn.tokyo-motion.net/icon.png"></body></html>`;
  assert.deepEqual(parseVideoPage(ogOnly), { thumb: 'https://cdn.tokyo-motion.net/og.jpg', user: '', duration: '' });
});

test('parseVideoPage は読めない入力で例外を投げず空を返す', () => {
  for (const input of ['', null, undefined, 42]) {
    assert.deepEqual(parseVideoPage(input), { thumb: null, user: '', duration: '' });
  }
});

test('googleVideoUrl は直リンクと /url?q= 平文から動画 ID を取り、それ以外は null', () => {
  assert.deepEqual(
    googleVideoUrl('https://www.tokyomotion.net/video/101/example'),
    { id: 101, url: 'https://www.tokyomotion.net/video/101' }
  );
  assert.deepEqual(
    googleVideoUrl('https://www.google.com/url?q=https%3A%2F%2Ftokyomotion.net%2Fvideo%2F202%2Fother'),
    { id: 202, url: 'https://www.tokyomotion.net/video/202' }
  );
  assert.equal(googleVideoUrl('https://example.test/video/303'), null);
  assert.equal(googleVideoUrl('https://www.tokyomotion.net/user/example'), null);
  assert.equal(googleVideoUrl('/goto?url=CAES-encrypted'), null);
  assert.equal(googleVideoUrl(''), null);
});
