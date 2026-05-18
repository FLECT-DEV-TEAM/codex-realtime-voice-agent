# codex-realtime-voice-agent

Voice-controlled coding agent that connects your browser microphone to OpenAI's Realtime API and dispatches code-change requests to a local [Codex](https://github.com/openai/codex) instance through [`codex-app-server-bridge`](https://www.npmjs.com/package/codex-app-server-bridge).

> 🇯🇵 日本語版: [README_jp.md](./README_jp.md)

## Architecture

```
┌────────────────┐   WebSocket   ┌────────────────┐   WebSocket   ┌──────────────────┐
│  Browser SPA   │ ◄───────────► │  Node.js Proxy │ ◄───────────► │  OpenAI Realtime │
│  (Vite/React)  │  PCM + JSON   │  (Express+ws)  │     PCM/JSON  │       API        │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │ JSON-RPC (stdio)
                                         ▼
                                ┌────────────────────┐
                                │   codex app-server │
                                │  (spawned subproc) │
                                └────────────────────┘
```

- **Browser** — captures mic at 48 kHz via `AudioWorklet`, downsamples to 24 kHz / mono / 16-bit PCM, sends to server as binary WebSocket frames. JSON control messages (start, stop, settings) share the same socket via text frames.
- **Server** — single WebSocket endpoint at `ws://localhost:8787/voice`. Proxies audio bidirectionally between the browser and the OpenAI Realtime API. Runs a deterministic approval policy + voice escalation flow. Invokes a local Codex subprocess via the `codex-app-server-bridge` JSON-RPC client whenever the model issues a `codex_turn` function call.
- **OpenAI Realtime API** — `gpt-realtime-2` (default) for reasoning, voice synthesis, and tool dispatch.
- **Codex** — performs the actual edits in `server/workspace/` (or whatever `CODEX_CWD` you point at). Sandbox is bypassed (`-c sandbox_mode=danger-full-access`) because approval is enforced via the policy/voice layer.

## Prerequisites

- Node.js 22+
- pnpm 9+
- `codex` CLI on `PATH` (login or API key set up)
- An OpenAI API key with Realtime API access (`OPENAI_API_KEY`)

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env, at minimum set OPENAI_API_KEY
```

`.env` keys:

| key                     | default              | meaning                      |
| ----------------------- | -------------------- | ---------------------------- |
| `OPENAI_API_KEY`        | _(required)_         | Key sent to the Realtime API |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2`     | Realtime model               |
| `OPENAI_REALTIME_VOICE` | `marin`              | TTS voice                    |
| `SERVER_PORT`           | `8787`               | WS/HTTP port on the server   |
| `CODEX_CWD`             | `./server/workspace` | Directory Codex operates in  |

## Run

```bash
pnpm dev
```

Then open <http://localhost:5273>, click **接続して会話開始**, allow microphone access, and start talking.

## UI

- **Transcript** — rolling user/agent text. Voice-only approval prompts/replies appear inline as `[approval]` notices.
- **Codex 進捗** — live `[Codex 進捗]` progress log (turn start/end, item events, exec output).
- **Settings** — choose model & voice, append extra system instructions. Persisted to `localStorage`; while a session is live, edits are pushed to the server with `settings/update`.

## Voice approval flow

Risky operations (deletes, network calls, `sudo`, …) trigger a deterministic policy filter on the server. When the filter returns `escalate`, the agent is forced to ask the user out loud, then forced (via `tool_choice: "required"` + a single tool) to emit a `voice_approval_response` function call carrying the user's spoken decision. No modal — by design, for now. The protocol is structured so a modal can be added later without changing the wire format.

## Project layout

```
client/             Vite + React + TypeScript SPA
  public/audio-worklet.js   Mic capture + speaker playback worklet
  src/audio/               AudioManager (worklet wrapper)
  src/ws/                  WebSocket client
  src/state/               zustand stores (session + persisted settings)
  src/components/          ConnectionControls / Transcript / Progress / Settings
  src/App.tsx              wiring
server/             Node 22 / TypeScript backend
  src/realtime-client.ts   OpenAI Realtime WS client (GA shape)
  src/approval-policy.ts   Deterministic policy classifier
  src/voice-approval.ts    2-phase voice approval coordinator
  src/session.ts           per-connection orchestrator
  src/index.ts             Express + ws + lifecycle
```

## License

MIT
