# codex-realtime-voice-agent

ブラウザのマイクで話しかけると、OpenAI Realtime API が音声 → 推論 → 音声を担当し、コード変更が必要な場面では [`codex-app-server-bridge`](https://www.npmjs.com/package/codex-app-server-bridge) 経由でローカルの [Codex](https://github.com/openai/codex) サブプロセスを叩いて実際の編集を行う、音声操作のコーディングエージェントです。

> 🇺🇸 English: [README.md](./README.md)

## デモ

[![デモ動画](https://img.youtube.com/vi/na1r6M-7z5A/hqdefault.jpg)](https://www.youtube.com/watch?v=na1r6M-7z5A)

## 全体構成

```
┌────────────────┐   WebSocket   ┌────────────────┐   WebSocket   ┌──────────────────┐
│  ブラウザ SPA  │ ◄───────────► │  Node プロキシ │ ◄───────────► │  OpenAI Realtime │
│  (Vite/React)  │   PCM+JSON    │  (Express+ws)  │   PCM / JSON  │        API       │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │ JSON-RPC (stdio)
                                         ▼
                                ┌────────────────────┐
                                │   codex app-server │
                                │ (子プロセスとして) │
                                └────────────────────┘
```

- **ブラウザ** — 48 kHz でマイク取得 → `AudioWorklet` 内で 24 kHz mono / 16-bit PCM にダウンサンプル → バイナリ WS フレームでサーバへ送信。開始/停止/設定変更などの制御は同じソケットの **テキスト** フレーム (JSON) で送ります。
- **サーバ** — `ws://localhost:8787/voice` で 1 接続だけ受け付け、音声を OpenAI Realtime と双方向に中継します。承認は **決定的ポリシーフィルタ + 音声エスカレーション** で扱い、モデルが `codex_turn` ファンクションを呼ぶたびに `codex-app-server-bridge` 経由で Codex を実行します。
- **OpenAI Realtime API** — 既定では `gpt-realtime-2`。推論・音声合成・tool dispatch をすべて担当。
- **Codex** — `server/workspace/` (もしくは `CODEX_CWD`) 配下で実際にコードを書き換えます。サンドボックスは無効化 (`-c sandbox_mode=danger-full-access`) しており、安全性はポリシー + 音声承認層で担保しています。

## 前提

- Node.js 22 以上
- pnpm 9 以上
- `codex` CLI が PATH 上にあること (ログイン済 or API キー設定済)
- Realtime API が使える `OPENAI_API_KEY`

## セットアップ

```bash
pnpm install
cp .env.example .env
# 少なくとも OPENAI_API_KEY は設定する
```

`.env` の設定値:

| キー                    | デフォルト           | 意味                         |
| ----------------------- | -------------------- | ---------------------------- |
| `OPENAI_API_KEY`        | _(必須)_             | Realtime API に送る API キー |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2`     | Realtime のモデル            |
| `OPENAI_REALTIME_VOICE` | `marin`              | TTS の声                     |
| `SERVER_PORT`           | `8787`               | サーバの待受ポート           |
| `CODEX_CWD`             | `./server/workspace` | Codex が作業するディレクトリ |

## 起動

```bash
pnpm dev
```

<http://localhost:5273> を開き、「接続して会話開始」を押してマイク許可を与えたら、そのまま話しかけてください。

## UI

- **Transcript** — ユーザー / エージェントのテキスト。音声承認のやり取りもインラインで `[approval]` 注記として記録されます。
- **Codex 進捗** — `[Codex 進捗]` 系のライブログ (turn 開始/完了, item イベント, exec 出力など)。
- **Settings** — モデル / 声 / 追加システム指示を変更できます。`localStorage` に永続化、セッション中の変更はサーバへ `settings/update` で即時反映。

## 国際化

このアプリには独立した 2 つの言語設定があります。

- **UI 言語** はブラウザ画面だけを切り替えます。Settings の **UI 言語** セレクトで `en` / `ja` を選べます。クライアント内で完結し、独立して `localStorage` に永続化され、サーバへは送られません。初期値は `navigator.language` から推定します。切り替えは reload 不要で、表示中の status / error / progress も含めて即時に再翻訳されます。
- **会話言語** は Settings の **会話言語** / transcription language セレクトです。サーバ側のプロンプト、Yes/No 承認判定、質問判定、承認読み上げ、Codex summary/detail の言語を決めます。

完全対応は現在 `en` / `ja` のみです。UI 言語では全 UI、会話言語ではプロンプト、Yes/No 判定、質問判定、summary、detail が対応しています。

`ko` / `zh` / `es` / `fr` / `de` と自動判定 (空値) は、会話言語としては yes/no 承認判定のみ簡易対応です。プロンプト、質問判定、承認読み上げは `auto` 経路の言語非依存扱いになります。安全側に倒すため accept 判定は保守的で、不明瞭な承認返答は承認扱いにせず確認へ戻します。

会話言語は接続時にスナップショットされます。稼働中セッションで `settings/update` により変更しても現在の会話には反映されません。反映するには再接続してください。

Gemini Live には、このアプリから STT 言語指定をまだ渡していません。承認読み上げは Realtime instructions ではなく `createResponse` の input text、つまり実際に発話させる文で担保するため、OpenAI Realtime とは効き方が異なります。

`instructionsExtra` は system instructions の後ろに付く上級者向け override です。通常会話本文の言語は `instructionsExtra` で上書きされ得ますが、承認読み上げ、Yes/No 判定、summary/detail は会話言語に固定されます。これらの発話文は `instructionsExtra` の影響を受けない形で生成されます。

## 音声承認フロー

削除、ネットワークアクセス、`sudo` などの危険操作は、サーバ側の決定的ポリシーフィルタ (`server/src/approval-policy.ts`) が判定します。フィルタは以下のいずれかを返します。

- **auto-accept** — ワークスペース内の通常操作は確認なしで進みます。
- **auto-refuse** — 明確に危険な操作 (`rm -rf /` や禁止トークン等) は即座に拒否します。
- **escalate** — それ以外は**音声承認コーディネータ** (`server/src/voice-approval.ts`) に委譲します。

エスカレーション時、コーディネータが設定された**会話言語** (Settings → 会話言語。`en` / `ja` 完全対応、それ以外は言語非依存の `auto` 束にフォールバック) で 2 フェーズの out-of-band 音声確認を行います。

1. まず **notice** (「すみません、いま Codex から確認の依頼が来ました…」) を短く読み上げて注意を引きます。
2. 続けて承認の **question** を音声で読み上げます (Codex が何をしようとしているかを 1 文に要約し、「はい か いいえ で答えてください」と促す)。生の shell コマンドやフルパスは意図的に読み上げません — basename と自然な要約だけにとどめます。

ユーザの口頭応答は Realtime の transcript から取り、`server/src/i18n/decision.ts` で**決定的に分類**します (LLM のツール呼び出しは使いません)。Yes/No 判定は言語別の安全側非対称マッチ (否定優先 refuse、保守的 accept)。曖昧な応答や本物の質問はクラリフィケーションラウンドへ回し (`MAX_CLARIFY` / `MAX_AMBIGUOUS` で上限あり)、上限超過は安全側の terminal として却下します。

判定結果 (`accept` / `refuse`) は Codex へ即座に返し、その後に短い結果文 (「承認しました。」/「却下しました。」) を out of band で読み上げます。承認モーダルは意図的に実装していません。プロトコル側は分離されているため、将来モーダルを追加する場合も wire format の変更なしで対応できます。

## ディレクトリ構成

```
client/             Vite + React + TypeScript の SPA
  public/audio-worklet.js   マイク入力 + 再生用 AudioWorklet
  src/audio/               AudioManager (worklet ラッパ)
  src/ws/                  WebSocket クライアント
  src/state/               zustand (セッション + 永続化された設定)
  src/components/          ConnectionControls / Transcript / Progress / Settings
  src/App.tsx              全体配線
server/             Node 22 / TypeScript のバックエンド
  src/realtime-client.ts   OpenAI Realtime WS クライアント (GA 形)
  src/approval-policy.ts   決定的ポリシ分類器
  src/voice-approval.ts    2 フェーズの音声承認コーディネータ
  src/session.ts           1 接続あたりのオーケストレータ
  src/index.ts             Express + ws + ライフサイクル
```

## 免責事項

- **サンドボックスは無効です。** Codex は `-c sandbox_mode=danger-full-access` で動作するため、実行ユーザの権限で任意のファイルの読み書きと任意のシェルコマンド実行が可能です。隔離された / 使い捨て可能な環境 (VM・コンテナ・捨ててよいマシン) でのみ実行してください。失って困るデータのあるディレクトリやマシンでは絶対に動かさないでください。
- **音声承認フローはセキュリティ境界ではありません。** 決定的ポリシーフィルタ + 口頭確認はあくまでベストエフォートの UX であり、サンドボックスではありません。プロンプトインジェクション・分類ミス・モデルの誤りで容易にすり抜けます。悪意ある / 誤動作するエージェントの封じ込めを期待しないでください。
- **OpenAI API 利用料金。** Realtime API は音声 / トークン量に応じた従量課金で、マイクの連続ストリーミングは短時間でも高額になりえます。`OPENAI_API_KEY` に紐づく全利用料はあなたの負担です。利用量の監視と上限設定を行ってください。
- **無保証。** 本ソフトウェアは現状有姿 (as is) で提供され、いかなる保証もありません。利用によって生じた損害・データ損失・意図しないコード変更・費用について、作者は一切責任を負いません。

## ライセンス

MIT
