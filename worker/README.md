# AI特筆データの中継 Worker

アプリの「AI特筆データ」は、この Worker を通して Claude に問い合わせます。APIキーとシステムプロンプトは Worker の中にだけ置き、iPad には置きません。

- `insight.js`：ハンドラー関数 `handleInsight(request, env)`（外部ライブラリなし）
- `index.js`：単独の Worker として動かすときの入口
- `wrangler.example.toml`：単独で動かすときの設定例

**デプロイは利用者が行います。** URL・APIキー・パスコードの実値はリポジトリに書かないでください。

## 1. 既存の中継 Worker に追加する

### ダッシュボードで編集している場合

1. Cloudflare ダッシュボード → Workers & Pages → 既存の中継 Worker →「コードを編集」
2. `insight.js` の中身をすべてコピーし、既存のコードの**いちばん上**に貼り付ける（`export` が付いたままで動きます）
3. 既存の `fetch(request, env)` の**最初**に次の2行を足す（ブラウザの事前確認の OPTIONS もここで受けます）

   ```js
   const url = new URL(request.url);
   if (url.pathname === '/basket/insight') return handleInsight(request, env);
   ```

   すでに `const url = new URL(request.url);` がある場合は2行目だけ足します。
4.「デプロイ」

### wrangler で管理している場合

1. `insight.js` を既存の Worker のフォルダにコピー
2. 入口のファイルで読み込み、`fetch` の最初で呼ぶ

   ```js
   import { handleInsight } from './insight.js';

   export default {
     async fetch(request, env, ctx) {
       const url = new URL(request.url);
       if (url.pathname === '/basket/insight') return handleInsight(request, env);
       // …既存の処理…
     },
   };
   ```

3. 次のコマンドでデプロイ

   ```bash
   npx wrangler deploy
   ```

## 2. シークレットと変数

| 名前 | 種類 | 内容 |
|---|---|---|
| `STAFF_PASS` | シークレット（必須） | スタッフ用パスコード。アプリの設定に同じものを入れる |
| `ANTHROPIC_API_KEY` | シークレット（必須） | Claude の APIキー。既存の中継で同じ名前を使っていればそのまま使える |
| `MODEL` | 変数（任意） | 既定 `claude-haiku-5-5`（速さ優先）。品質を上げたいときは `claude-sonnet-5-5` |
| `ALLOWED_ORIGINS` | 変数（任意） | 呼び出しを許可するサイト。既定 `https://goldfish0824-web.github.io`。カンマ区切りで複数可 |
| `MAX_TOKENS` | 変数（任意） | 既定 `1000` |
| `EFFORT` | 変数（任意） | 既定 `low` |

ダッシュボードでは Worker の「設定 → 変数とシークレット」で追加します。wrangler の場合は次のとおり（値は聞かれたときに入力）。

```bash
npx wrangler secret put STAFF_PASS
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

## 3. アプリ側の設定

1. アプリの「設定」→「AI接続（AI特筆データ）」
2. **Worker の URL**：中継 Worker の URL（例：`https://<Worker名>.<アカウント名>.workers.dev`）。末尾の `/basket/insight` は付けても付けなくてもよい
3. **スタッフ用パスコード**：`STAFF_PASS` と同じもの
4.「接続テスト」→「接続できました」と出れば完了（接続テストは AI を呼ばないので料金はかかりません）

URL とパスコードは iPad の中だけに保存され、バックアップのファイルにも入りません。

## 4. 動作の確認（任意）

接続テストと同じ「候補0件」の問い合わせです。AI は呼ばれず `{"insights":[]}` が返れば、認証と CORS 以外の経路は通っています。

```bash
curl -s -X POST "https://<Worker名>.<アカウント名>.workers.dev/basket/insight" \
  -H "Content-Type: application/json" \
  -H "X-Staff-Pass: <スタッフ用パスコード>" \
  -d '{"kind":"quarter_insight","quarterEnded":2,"isHalftime":true,"score":{"us":0,"opp":0,"byQuarter":{"us":[],"opp":[]}},"candidates":[]}'
```

## 仕様（SPEC 5-6）

- ルート：`POST /basket/insight`
- 認証：ヘッダー `X-Staff-Pass` を `STAFF_PASS` と照合。違えば 401
- CORS：`ALLOWED_ORIGINS` のサイトだけ許可（それ以外の Origin は 403）
- 受け取る形：SPEC 5-5 の `quarter_insight`。候補は最大20件、決まった項目だけを AI に渡す（名前などは渡さない）
- AI への問い合わせ：Messages API（`MODEL`、`effort: low`、応答の形を JSON スキーマで固定）
- 返す形：`{"insights":[{"candidateId":"c1","line":"…"}]}`。候補にない `candidateId` は捨て、最大3行
- AI の出力を読めない・AI が断った・AI 側のエラー：502（アプリは端末内の自動抽出に切り替える）
- アプリは10秒で応答がなければ諦める。Worker も AI への問い合わせを9秒で打ち切る

## 料金の目安

`claude-haiku-5-5` は入力 100万トークンあたり $0.10、出力 $0.50（プロンプトが10万トークン以下のとき）。1回の問い合わせは入力2,000〜3,000トークン程度なので、1試合で数回押しても1円未満です（2026年10月時点の公開価格。最新は Anthropic の料金ページで確認）。
