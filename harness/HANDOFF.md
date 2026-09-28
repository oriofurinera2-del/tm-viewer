# 引き継ぎと作業の割り振り（Claude Code ⇄ Codex）

最終更新: 2026-09-28（Claude Code）

作業を始める前に読む順番: `AGENTS.md`（Codex）/ `CLAUDE.md`（Claude）→ このファイル → `docs/DESIGN.md` の該当節。

---

## 1. 現在地

- 設計: `docs/DESIGN.md` で v0.1 の仕様はほぼ確定。フィード画面は `docs/mock/feed.html` を正とする（5 章）。
- サイトの HTML 構造: ログイン後の画面で確認済み。結果は DESIGN.md **8 章**（URL・セレクタ・1 ページの件数など）。
- コード: **まだ 1 行も無い**。次は v0.1 の実装。
- git: 未使用（リポジトリになっていない）。

## 2. 割り振りの考え方

- **Claude**: ログイン済みのサイトを見られる（アプリ内ブラウザ）。サイトの HTML に依存する部分と、確認・レビューを持つ。
- **Codex**: サイトを見なくても DESIGN.md とモックだけで作れる部分を持つ。
- 担当ファイルを分け、**相手の担当ファイルは編集しない**。変更が必要なら、このファイルの「5. 連絡」に書く。

## 3. ファイル構成（予定）

```
package.json              … Codex
src/main/main.js          … Codex  起動・ウィンドウ・IPC
src/main/session.js       … Codex  persist:tm セッション・広告遮断・遷移制限
src/main/fetcher.js       … Codex  取得キュー・キャッシュ（DESIGN 4.4）
src/main/store.js         … Codex  userData の JSON 保存（DESIGN 6 章）
src/main/parser.js        … Claude サイト HTML の解析（ここだけでサイトの形を知る）
src/preload/preload.js    … Codex
src/renderer/*            … Codex  画面（モックを実データ化）
data/blocklist.json       … Codex  広告ドメインの初期リスト
test/fixtures/*.html      … Claude 実ページを保存し、画像 URL・サムネ・成人向けの本文を除いたもの
test/parser.test.js       … Claude
test/*.test.js（その他）  … Codex
```

テストは Node 標準の `node:test` を使う（追加の依存を増やさない）。

### parser.js の約束（Codex はこの形を前提に作ってよい）

```js
parseMe(html)          // → "自分のユーザー名" | null
parseUserList(html)    // フレンド一覧・購読一覧 → { users: ["名前", ...], lastPage: 数 }
parseVideoList(html)   // /user/<名前>/videos → { videos: [{ id, title, duration, hd, private, thumb, ago }], lastPage: 数 }
parseVideoTags(body)   // /ajax/video_tag の応答 → ["タグ", ...]   ※応答の形は未確認（K2）
```

- `id` は数値、`ago` はサイトの表示そのまま（例 "23 時 前"）。推定投稿日への変換は Codex 側（DESIGN 4.3）。
- 読めなかったときは例外を投げず、空配列と `lastPage: 1` を返す。

## 4. タスク一覧

| ID | 担当 | 内容 | DESIGN | 完了条件 | 状態 |
|---|---|---|---|---|---|
| C1 | Codex | 土台: package.json、main、preload、session。サイト表示（戻る/進む・アドレス・「フィードへ戻る」）。広告遮断と外部遷移・`window.open` の拒否 | 3 章, 4.1, 4.5, 5 章 | `npm start` で起動し、サイト表示でログイン画面が出る。外部ドメインへの遷移が止まる。サイト自身の `/ajax/…` `/vsrc/…` は止めない | 未着手 |
| K1 | Claude | parser.js・fixtures・parser のテスト | 8 章 | `node --test` が通る | 未着手 |
| C2 | Codex | fetcher（1 件ずつ・2 秒間隔・30 分キャッシュ・429/5xx で停止）と store | 4.4, 6 章 | parser をダミーにしたテストが通る | C1 の後 |
| C3 | Codex | フィード画面をモックから実データへ（すべて／絞り込み／非表示／100 件ページ送り／個人の全動画／見られる動画だけ／視聴済み／推定投稿日） | 4.2, 4.3, 4.6, 5 章 | ログインして更新するとフィードが出る | C2・K1 の後 |
| K2 | Claude | `/ajax/video_tag` の送る内容と応答を、C1 のアプリ内で確認し parseVideoTags を完成 | 4.2, 8 章 | 実際のタグが取れる | C1 の後 |
| C4 | Codex | 名前・タグ・得点、整理した動画画面、書き出し/読み込み | 4.8 | 付けた内容が再起動後も残る | C3 の後 |
| C5 | Codex | electron-builder で portable exe | 2 章, 3 章 | exe 1 つで起動する | 最後 |
| K3 | Claude | 各タスク後のレビュー、実サイトでの動作確認、DESIGN.md への反映 | — | — | 随時 |

並行してよいのは **C1 と K1** だけ。ほかは上から順に。

## 5. 連絡（相手への依頼・質問・引き継ぎ）

新しいものを上に書く。済んだら「済」を付ける。

- （まだ無し）

## 6. 共通ルールの要点（詳細は CLAUDE.md / AGENTS.md / harness/README.md）

- 方針が決まっていないことは実装しない。DESIGN.md に無い判断が要るときは、ここに書いてユーザーに聞く。
- ID・パスワードを読まない・保存しない・ログに出さない。ダウンロード機能を作らない。書き込み操作（申請・投稿など）を自動化しない。
- フレンド一覧・購読一覧には「削除」ボタンがある。取得処理はリンクを読むだけ。
- 実サイトへの連続アクセスは DESIGN 4.4 の間隔を守る。テストは実サイトに接続しない。
- リポジトリに成人向けの画像・本文を入れない（fixtures も除去してから置く）。
- タスクを終えたら、この表の「状態」と「5. 連絡」を更新する。
