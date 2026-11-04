# AI特筆データの中継 Worker

アプリの「AI特筆データ」は、この Worker を通して Claude に問い合わせます。APIキーとシステムプロンプトは Worker の中にだけ置き、iPad には置きません。

- `insight.js`：ハンドラー関数 `handleInsight(request, env)`（外部ライブラリなし）。AI特筆データと「対処の例」の両方を受ける
- `dashboard.js`：**Cloudflare の画面で作った Worker にまるごと貼る1ファイル版**（`insight.js` と入口を1つにしたもの。`node worker/make-dashboard.mjs` で作る）
- `index.js`：単独の Worker として動かすときの入口（wrangler 用）
- `wrangler.example.toml`：単独で動かすときの設定例

**デプロイは利用者が行います。** URL・APIキー・パスコードの実値はリポジトリに書かないでください。

## 0. Claude の APIキーを用意する（最初に1回）

### 料金と月の上限

1. Claude Console（https://platform.claude.com ）でアカウントを作る
2. 請求のページ（https://platform.claude.com/settings/billing ）でクレジットを買う（前払い。少額で足りる。下の「料金の目安」を参照）
3. 同じページの「Spend limits」で、月の上限（例：5ドル）を決めておく。上限に達すると AI は止まるが、アプリは iPad の中の自動抽出に切り替わるので、記録は止まらない

### APIキーを作る

APIキーのページ（https://platform.claude.com/settings/keys ）で「Create key」を押す。

| 項目 | 選び方 |
|---|---|
| 名前 | 分かる名前なら何でもよい（例：`basket-analyst`） |
| ワークスペース | **必ず1つ選ぶ**（「Default Workspace」でよい）。選ばずに作ったキーは、リクエストごとにワークスペースの指定が必要になり、この Worker は指定しないので毎回エラーになる（アプリには「（自動抽出・AIなし）」だけが出る） |
| 有効期限 | シーズン中に切れないよう、長め（例：1年）か「Never」。切れる7日前にメールが届く。切れると AI は止まる（新しいキーを作って入れ直す） |

- 表示されたキー（`sk-ant-api…`）をコピーし、すぐ次の「2. シークレットと変数」で `ANTHROPIC_API_KEY` に入れる。メモ帳・アプリ・GitHub・チャットなど、ほかの場所には保存しない
- 漏れたかもしれないときは、同じページでキーを「Disable」（無効化。あとで戻せる）か「Delete」（削除。戻せない）にして、新しいキーを作る

## 1. Worker にコードを入れる

### このアプリ専用の Worker を Cloudflare の画面で作る（おすすめ）

ほかのアプリが使っている Worker に手を入れないので、貼り間違えてもほかのアプリは止まりません。

1. Cloudflare ダッシュボード → Workers & Pages →「Create application」→「Start with Hello World!」
2. 名前（例：`basket-insight`）を入れて「Deploy」
3.「Edit code」→ `worker.js` の中身をすべて消し、[`dashboard.js`](dashboard.js) の中身を**まるごと**貼って「Deploy」
4. 次の「2. シークレットと変数」を登録する。Worker の URL は `https://<Worker名>.<アカウント名>.workers.dev`

**アプリの更新で Worker のコードが変わったとき**は、手順3（`dashboard.js` をまるごと貼り直して「Deploy」）だけをやり直します。シークレットと変数はそのまま残ります。

### 既存の中継 Worker に追加する（ダッシュボードで編集している場合）

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
| `MAX_TOKENS` | 変数（任意） | AI特筆データの上限。既定 `1000` |
| `EFFORT` | 変数（任意） | 既定 `low` |
| `ADVICE_MODEL` | 変数（任意） | 「対処の例」だけ別のモデルにするとき（例：`claude-sonnet-5-5`）。未設定なら `MODEL` と同じ |
| `ADVICE_MAX_TOKENS` | 変数（任意） | 「対処の例」の上限。既定 `2000` |
| `REPORT_MODEL` | 変数（任意） | 試合後の「AIふりかえり」のモデル。既定 `claude-sonnet-5-5`（文章の質を優先）。試合中の2つ（特筆データ・対処の例）は `MODEL` のまま |
| `REPORT_MAX_TOKENS` | 変数（任意） | 「AIふりかえり」の上限。既定 `8000` |
| `REPORT_EFFORT` | 変数（任意） | 「AIふりかえり」の考える深さ。既定 `medium` |

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

## 4. 動作の確認

### AI が本当に動くか（アプリで）

1. アプリでデモ試合を作り、記録画面で「クォーター終了」→「AI特筆データ」
2. 「（自動抽出・AIなし）」と**出なければ** AI が選んだ結果。出たときは下の「うまく動かないとき」を見る
3. 呼ばれた回数と金額は Claude Console の利用状況のページ（https://platform.claude.com/usage ）で見られる

### Worker までの経路だけ（任意）

接続テストと同じ「候補0件」の問い合わせです。AI は呼ばれず `{"insights":[]}` が返れば、認証と CORS 以外の経路は通っています。

```bash
curl -s -X POST "https://<Worker名>.<アカウント名>.workers.dev/basket/insight" \
  -H "Content-Type: application/json" \
  -H "X-Staff-Pass: <スタッフ用パスコード>" \
  -d '{"kind":"quarter_insight","quarterEnded":2,"isHalftime":true,"score":{"us":0,"opp":0,"byQuarter":{"us":[],"opp":[]}},"candidates":[]}'
```

## うまく動かないとき

「接続テスト」は通るのに、AI特筆データが「（自動抽出・AIなし）」になる場合は、次を順に確かめます。

| 確かめること | 直し方 |
|---|---|
| APIキーを作るときにワークスペースを選んだか | 選んでいなければ、ワークスペースを選んでキーを作り直し、`ANTHROPIC_API_KEY` を入れ直す |
| クレジットの残高があるか | 請求のページでクレジットを買い足す |
| 月の上限（Spend limits）に達していないか | 上限を上げるか、翌月まで待つ |
| シークレットの名前が `ANTHROPIC_API_KEY` と1文字も違わないか | 名前を直して入れ直す |
| APIキーの有効期限が切れていないか | 新しいキーを作って入れ直す |
| `MODEL` を変えた場合、正しいモデル名か | 空に戻す（既定の `claude-haiku-5-5` になる） |

Worker のコードが更新されたとき（AI への指示文を変えたとき、新しい機能を足したときなど）は、「1. Worker にコードを入れる」の手順でもう一度貼り直してデプロイします（専用の Worker なら `dashboard.js` をまるごと）。シークレットと変数はそのまま残ります。

「対処の例を聞く」で「AIの中継でエラーが起きました（400）」と出るときは、Worker のコードが古いままです。`dashboard.js` を貼り直してください。

## 対処の例（AIに聞く）

クォーター終了画面の「対処の例を聞く」と質問の欄から、同じ `POST /basket/insight` に `kind: "advice"` で問い合わせます。

- 送るもの：その特筆データの1行と数字（候補）、または入力した質問（200字まで）、点数、直近の守備隊形、場面別Q&A の一覧（id と題名）。選手の名前は送らない
- AI への指示：決めるのはコーチ。「〜すべき」とは書かず、選ぶための「対処の例」を2〜3個。ルールは FIBA。「TO」と略さない
- 返す形：`{"options":[{"label":"…","detail":"…"}],"related":["press-221"]}`。例は最大3つ、`related` は送った一覧にある id だけ最大2つ
- 特筆データも質問もなければ 400。AI の出力を読めない・断った・AI 側のエラーは 502
- アプリは20秒で応答がなければ諦める。Worker も AI への問い合わせを18秒で打ち切る

## AIふりかえり（試合後）

振り返り画面の「AIふりかえり」から、同じ `POST /basket/insight` に `kind: "game_report"` で問い合わせます。

- 送るもの：端末で計算した試合全体の数字（点数、チーム合計、背番号ごとの数字、守備隊形別、シュートの場所別、ターンオーバーの種類、各クォーターの特筆データ）、チェック項目の名前と◯△×・目標の自動判定、「AIに伝えたいこと」。選手の名前・相手校名・チェック項目のメモは送らない（Worker でも `name`・`memo`・`opponent` などの項目は捨てる）
- モデル：`REPORT_MODEL`（既定 `claude-sonnet-5-5`）。Sonnet など対応するモデルには、安全のための判定で断られたときに Anthropic の勧めるモデルで自動でやり直す設定（`fallbacks: "default"`、ヘッダー `anthropic-beta: server-side-fallback-2026-07-01`）を付ける。Haiku には付けない
- 返す形：`{"summary":"…","good":[{"point":"…","evidence":"…"}],"issues":[…],"practice":[{"issue":"…","menu":"…","detail":"…","minutes":15}],"watch":["…"]}`
- 得点の記録がなければ 400（AI は呼ばない）。AI の出力を読めない・AI 側のエラーは 502
- アプリは90秒で応答がなければ諦める。Worker も AI への問い合わせを85秒で打ち切る

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

| モデル | 単価（100万トークンあたり） | 1回の目安 | 1試合で10回押したとき |
|---|---|---|---|
| `claude-haiku-5-5`（既定） | 入力 $0.10・出力 $0.50（プロンプトが10万トークン以下のとき） | 約0.1円 | 2円未満 |
| `claude-sonnet-5-5`（`MODEL` で変更） | 入力 $2・出力 $10 | 約2〜3円 | 数十円 |

AI特筆データの1回の問い合わせは入力2,000〜3,000トークン、出力は最大1,000トークン（`MAX_TOKENS`）です。「対処の例」は場面別Q&A の題名も送るので入力3,000〜4,000トークン・出力は最大2,000トークンで、`claude-haiku-5-5` なら1回0.2円ほどです。試合後の「AIふりかえり」は `claude-sonnet-5-5` で入力4,000〜6,000トークン・出力（考える分を含む）2,000〜5,000トークンほどなので、1回5〜10円ほどです。円は1ドル150円で計算しています。`claude-sonnet-5-5` は文章の質が上がるかわりに応答が遅く、アプリは10秒で待つのをやめるため「AIなし」になる回数が増えることがあります（2026年10月時点の公開価格。最新は https://platform.claude.com/docs/en/about-claude/pricing で確認）。
