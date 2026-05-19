/**
 * WebSocket protocol shared between the browser client and the Node server.
 *
 * KEEP IN SYNC with `server/src/types/messages.ts` (manual duplication).
 *
 * Wire format:
 *   - Binary frames: raw PCM int16 LE mono audio. Mic input is provider-rate
 *     (OpenAI 24 kHz, Gemini 16 kHz); output playback is 24 kHz.
 *   - Text frames: JSON-encoded {@link ClientToServerMessage} or
 *     {@link ServerToClientMessage}
 */
import type { MessageKey } from "../i18n/en.js";

export type LocKey = MessageKey;
export type Loc = { key: LocKey; params?: Record<string, string | number> };
export type LocOrText = { text: string } | { loc: Loc };

export type ClientToServerMessage =
    | { type: "session/start"; settings?: Partial<SessionSettings> }
    | { type: "session/stop" }
    | { type: "settings/update"; settings: Partial<SessionSettings> };

export type ServerToClientMessage =
    | { type: "session/status"; state: SessionState; message?: LocOrText }
    | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
    | {
          type: "codex/progress";
          body: LocOrText;
          level: "info" | "warn" | "error";
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
    | { type: "approval/notice"; summary: string; kind: string }
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
    inputCachedTextTokens: number;
    inputCachedAudioTokens: number;
    outputTextTokens: number;
    outputAudioTokens: number;
    outputReasoningTokens: number;
};

export type SessionState =
    | "idle"
    | "connecting"
    | "ready"
    | "active"
    | "stopping"
    | "error"
    | "stopped";

export interface SessionSettings {
    voiceProvider: "openai" | "gemini";
    model: string;
    voice: string;
    instructionsExtra: string;
    transcriptionModel: string;
    transcriptionLanguage: string;
    codexReasoningEffort: string;
    /** OpenAI input-audio noise reduction: "near_field" | "far_field" |
     *  "off". Applied at session start (OpenAI provider only). */
    noiseReduction: string;
}
