# codex-realtime-voice-agent

ブラウザのマイクで話しかけると、OpenAI Realtime API が音声 → 推論 → 音声を担当し、コード変更が必要な場面では [`codex-app-server-bridge`](https://www.npmjs.com/package/codex-app-server-bridge) 経由でローカルの [Codex](https://github.com/openai/codex) サブプロセスを叩いて実際の編集を行う、音声操作のコーディングエージェントです。

> 🇺🇸 English: [README.md](./README.md)

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

## 音声承認フロー

削除、ネットワークアクセス、`sudo` などの危険操作はサーバ側の決定的フィルタが拾います。フィルタが `escalate` を返した場合のみ、エージェントは音声でユーザに確認します。返答取得時は `tool_choice: "required"` + 1 ツールだけ提示する戦略で `voice_approval_response` ファンクションを強制発火させ、ユーザの口頭判断を受け取ります。承認モーダルは現時点では実装していませんが、将来追加できるようプロトコル側は分離してあります。

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

## ライセンス

MIT
