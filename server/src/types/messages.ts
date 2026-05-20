/**
 * WebSocket protocol shared between the browser client and the Node server.
 *
 * KEEP IN SYNC with `client/src/types/messages.ts` (intentional duplication
 * since the two packages don't share a workspace lib; the shape is small
 * enough to maintain manually).
 *
 * Wire format:
 *   - **Binary frames**: raw PCM int16 little-endian mono. Mic input sample
 *     rate is provider-dependent (OpenAI 24 kHz, Gemini 16 kHz); model audio
 *     output is 24 kHz.
 *   - **Text frames**: JSON-encoded {@link ClientToServerMessage} or
 *     {@link ServerToClientMessage}, distinguished by the `type` field.
 */

import type { LocKey } from "../i18n/loc-keys.js";

export type Loc = { key: LocKey; params?: Record<string, string | number> };
export type LocOrText = { text: string } | { loc: Loc };

/** All messages the browser sends to the server (text frames). */
export type ClientToServerMessage =
    | { type: "session/start"; settings?: Partial<SessionSettings> }
    | { type: "session/stop" }
    | { type: "settings/update"; settings: Partial<SessionSettings> };

/** All messages the server sends to the browser (text frames). */
export type ServerToClientMessage =
    | { type: "session/status"; state: SessionState; message?: LocOrText }
    | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
    | {
          type: "codex/progress";
          body: LocOrText;
          level: "info" | "warn" | "error";
          /** True for partial text-delta chunks that the UI should append
           *  to the previous streaming line instead of starting a new row. */
          streaming?: boolean;
      }
    | {
          type: "codex/status";
          /** Localizable summary of the current Codex activity. */
          loc: Loc;
          /** Wallclock ms when the current turn started (null when no turn is active). */
          turnStartedAt: number | null;
          /** Wallclock ms of the most recent bridge event (null when no turn is active). */
          lastEventAt: number | null;
      }
    | { type: "codex/turn"; turnId: string | null }
    | { type: "codex/tokenUsage"; tokenUsage: CodexTokenUsage }
    | { type: "realtime/tokenUsage"; usage: RealtimeUsage; costUsd: number }
    | { type: "approval/notice"; summary: string; kind: string; detail?: string }
    | { type: "audio/flush" }
    | {
          type: "settings";
          settings: SessionSettings;
          codexThreadId?: string;
          sessionId?: string;
          logFile?: string;
      }
    | { type: "error"; body: LocOrText; fatal: boolean };

export type CodexTokenUsageBreakdown = {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
};

export type CodexTokenUsage = {
    total: CodexTokenUsageBreakdown;
    last: CodexTokenUsageBreakdown;
    modelContextWindow: number | null;
};

export type RealtimeUsage = {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    inputTextTokens: number;
    inputAudioTokens: number;
    inputCachedTokens: number;
    /** Cached portion of inputTextTokens (already counted inside inputTextTokens). */
    inputCachedTextTokens: number;
    /** Cached portion of inputAudioTokens (already counted inside inputAudioTokens). */
    inputCachedAudioTokens: number;
    outputTextTokens: number;
    outputAudioTokens: number;
    outputReasoningTokens: number;
};

/** Lifecycle state of the agent session, surfaced to the UI. */
export type SessionState =
    | "idle"
    | "connecting"
    | "ready"
    | "active"
    | "stopping"
    | "error"
    | "stopped";

/**
 * Runtime-tunable settings that the SettingsPanel can change. A subset is
 * persisted to `localStorage` on the browser; the server reads the full set
 * from `.env` at boot and accepts overrides via `session/start`.
 */
export interface SessionSettings {
    /** Voice backend provider. */
    voiceProvider: "openai" | "gemini";
    /** Provider model. */
    model: string;
    /** TTS voice. */
    voice: string;
    /** Custom system instructions appended to the default. */
    instructionsExtra: string;
    /** Transcription model for the user's audio input. */
    transcriptionModel: string;
    /** Transcription language (ISO-639-1) — empty string = auto-detect. */
    transcriptionLanguage: string;
    /** Codex reasoning effort ("low" | "medium" | "high"). Empty string =
     *  use whatever `model_reasoning_effort` is set to in the user's
     *  ~/.codex/config.toml. Applied per-turn via the bridge so it can
     *  change mid-session without a Codex restart. */
    codexReasoningEffort: string;
    /** OpenAI Realtime input-audio noise reduction (applied to the input
     *  buffer *before* VAD/transcription, improving turn-detection
     *  accuracy). "near_field" = close mics (headset), "far_field" =
     *  laptop/room mics, "off" = disabled. OpenAI provider only; applied
     *  at session start. */
    noiseReduction: string;
}
