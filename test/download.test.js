'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  READ_PLAYER_SOURCES_SCRIPT,
  buildFileName,
  createDownloadQueue,
  extensionFor,
  pickVideoUrl,
  sanitizeFileName,
  uniqueFilePath,
  videoIdFromUrl
} = require('../src/main/download');

test('ファイル名は「独自の名前（無ければタイトル）_動画ID.拡張子」', () => {
  assert.equal(buildFileName({ name: '独自名', title: '元の題', id: 12, ext: 'mp4' }), '独自名_12.mp4');
  assert.equal(buildFileName({ name: '  ', title: '元の題', id: 12, ext: 'webm' }), '元の題_12.webm');
  assert.equal(buildFileName({ title: '', id: 12 }), '12.mp4');
  assert.equal(buildFileName({ title: 'テスト', id: 12, ext: 'exe' }), 'テスト_12.mp4');
  assert.throws(() => buildFileName({ title: 'テスト', id: 0 }));
});

test('Windows で使えない文字を置き換える', () => {
  assert.equal(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFileName('改行\nと\tタブ'), '改行 と タブ');
  assert.equal(sanitizeFileName('末尾の点...  '), '末尾の点');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(Array.from(sanitizeFileName('あ'.repeat(300))).length, 100);
});

test('同名のファイルがあれば番号を付ける', () => {
  const dir = path.join('C:', 'dl');
  const existing = new Set([path.join(dir, 'サンプル_1.mp4'), path.join(dir, 'サンプル_1 (2).mp4')]);
  assert.equal(uniqueFilePath(dir, 'サンプル_1.mp4', p => existing.has(p)), path.join(dir, 'サンプル_1 (3).mp4'));
  assert.equal(uniqueFilePath(dir, '新規_2.mp4', p => existing.has(p)), path.join(dir, '新規_2.mp4'));
});

test('拡張子はファイル名・MIME・URL の順で決め、無ければ mp4', () => {
  assert.equal(extensionFor({ filename: 'x.webm', mimeType: 'video/mp4' }), 'webm');
  assert.equal(extensionFor({ filename: 'download', mimeType: 'video/webm' }), 'webm');
  assert.equal(extensionFor({ url: 'https://cdn.tokyomotion.net/a/b.m4v?x=1' }), 'm4v');
  assert.equal(extensionFor({ filename: '', mimeType: 'application/octet-stream', url: 'https://www.tokyomotion.net/vsrc/sd/1' }), 'mp4');
});

test('動画ページの URL から動画 ID を読む', () => {
  assert.equal(videoIdFromUrl('https://www.tokyomotion.net/video/123'), 123);
  assert.equal(videoIdFromUrl('https://www.tokyomotion.net/video/123/sample-title'), 123);
  assert.equal(videoIdFromUrl('https://www.tokyomotion.net/videos'), null);
  assert.equal(videoIdFromUrl('https://example.com/video/123'), null);
  assert.equal(videoIdFromUrl('not a url'), null);
});

test('プレイヤーの URL は HD を優先し、サイトの配信元以外は使わない', () => {
  const sd = { src: 'https://www.tokyomotion.net/vsrc/sd/abc', title: 'SD' };
  const hd = { src: 'https://www.tokyomotion.net/vsrc/hd/abc', title: 'HD' };
  assert.deepEqual(pickVideoUrl([sd, hd]), { url: hd.src, hd: true });
  assert.deepEqual(pickVideoUrl([sd]), { url: sd.src, hd: false });
  assert.deepEqual(pickVideoUrl([{ src: 'https://www.tokyomotion.net/vsrc/x', hd: true }, sd]).hd, true);
  assert.equal(pickVideoUrl([{ src: 'blob:https://www.tokyomotion.net/1' }]), null);
  assert.equal(pickVideoUrl([{ src: 'https://example.com/video.mp4', title: 'HD' }]), null);
  assert.equal(pickVideoUrl([{ src: '' }]), null);
  assert.equal(pickVideoUrl(null), null);
});

test('ページで実行するスクリプトは video と source だけを読む', () => {
  assert.match(READ_PLAYER_SOURCES_SCRIPT, /querySelectorAll\('video source, video'\)/);
  assert.doesNotMatch(READ_PLAYER_SOURCES_SCRIPT, /input|password|cookie|form/i);
});

test('キューは 1 本ずつ追加した順に保存する', async () => {
  const log = [];
  let running = 0;
  const queue = createDownloadQueue({
    resolveUrl: async job => {
      running += 1;
      assert.equal(running, 1);
      log.push(`resolve ${job.id}`);
      return { url: `https://www.tokyomotion.net/vsrc/sd/${job.id}`, hd: false };
    },
    save: async (job, _found, onProgress) => {
      onProgress(50);
      await new Promise(resolve => setImmediate(resolve));
      log.push(`save ${job.id}`);
      running -= 1;
      return { fileName: `${job.id}.mp4` };
    }
  });

  assert.equal(queue.add({ id: 1 }), true);
  assert.equal(queue.add({ id: 2 }), true);
  assert.equal(queue.add({ id: 1 }), false);
  assert.equal(queue.add({ id: 3 }), true);
  await queue.idle();

  assert.deepEqual(log, ['resolve 1', 'save 1', 'resolve 2', 'save 2', 'resolve 3', 'save 3']);
  assert.equal(queue.active, null);
  assert.deepEqual(queue.pending, []);
});

test('URL が取れない動画は失敗として知らせ、保存せずに次へ進む', async () => {
  const updates = [];
  const saved = [];
  const queue = createDownloadQueue({
    resolveUrl: async job => (job.id === 1 ? null : { url: 'https://www.tokyomotion.net/vsrc/hd/2', hd: true }),
    save: async (job, found, onProgress) => {
      saved.push(found.url);
      onProgress(40.7);
      return { fileName: 'テスト_2.mp4' };
    },
    onUpdate: status => updates.push(status)
  });

  queue.add({ id: 1, name: 'テスト1' });
  queue.add({ id: 2, name: 'テスト2' });
  await queue.idle();

  assert.deepEqual(saved, ['https://www.tokyomotion.net/vsrc/hd/2']);
  const first = updates.filter(x => x.id === 1).map(x => x.state);
  assert.deepEqual(first, ['queued', 'resolving', 'failed']);
  const second = updates.filter(x => x.id === 2);
  assert.deepEqual(second.map(x => x.state), ['queued', 'resolving', 'downloading', 'downloading', 'done']);
  assert.equal(second[3].percent, 40);
  assert.equal(second.at(-1).fileName, 'テスト_2.mp4');
});

test('保存の失敗と、終わった後に足した動画も扱う', async () => {
  const updates = [];
  const queue = createDownloadQueue({
    resolveUrl: async () => ({ url: 'https://www.tokyomotion.net/vsrc/sd/1' }),
    save: async job => { if (job.id === 1) throw new Error('保存に失敗しました'); return {}; },
    onUpdate: status => updates.push(status)
  });

  queue.add({ id: 1 });
  await queue.idle();
  queue.add({ id: 2 });
  await queue.idle();

  assert.equal(updates.find(x => x.id === 1 && x.state === 'failed').message, '保存に失敗しました');
  assert.equal(updates.at(-1).state, 'done');
  assert.throws(() => queue.add({ id: 'x' }));
});
