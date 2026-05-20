/**
 * Application state managed via zustand.
 *
 * Two stores:
 *   - **useSessionStore**: ephemeral — current connection state, transcript
 *     lines, progress log, approval notices, server-reported settings.
 *   - **useSettingsStore**: persisted to localStorage — user-tunable
 *     defaults (model, voice, instructionsExtra) that the SettingsPanel
 *     drives.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
    CodexTokenUsage,
    Loc,
    LocOrText,
    RealtimeUsage,
    SessionSettings,
    SessionState,
} from "../types/messages.js";

export interface CodexStatus {
    loc: Loc;
    turnStartedAt: number | null;
    lastEventAt: number | null;
}

export interface TranscriptLine {
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
}

export interface ProgressLine {
    id: string;
    body: LocOrText;
    level: "info" | "warn" | "error";
    timestamp: number;
    /** If true, this line was assembled from streaming deltas; the next
     *  streaming chunk of the same level should append to it. */
    streaming?: boolean;
}

export interface ApprovalNotice {
    id: string;
    summary: string;
    kind: string;
    /** Sanitised display body (kind / command / cwd / fileTargets lines) sent
     *  by the server. Absent for idle escalation and pre-detail server builds. */
    detail?: string;
    timestamp: number;
}

export interface SessionStore {
    state: SessionState;
    statusMessage: LocOrText | null;
    transcript: TranscriptLine[];
    progressLog: ProgressLine[];
    approvalNotices: ApprovalNotice[];
    serverSettings: SessionSettings | null;
    codexThreadId: string | null;
    codexTurnId: string | null;
    codexStatus: CodexStatus | null;
    codexTokenUsage: CodexTokenUsage | null;
    realtimeUsage: { usage: RealtimeUsage; costUsd: number } | null;
    sessionId: string | null;
    logFile: string | null;
    error: LocOrText | null;

    setState: (state: SessionState, message?: LocOrText | null) => void;
    appendTranscript: (role: "user" | "assistant", text: string) => void;
    appendProgress: (body: LocOrText, level: ProgressLine["level"], streaming?: boolean) => void;
    appendApprovalNotice: (notice: { summary: string; kind: string; detail?: string }) => void;
    setServerSettings: (
        settings: SessionSettings,
        codexThreadId?: string,
        sessionId?: string,
        logFile?: string,
    ) => void;
    setCodexTurnId: (turnId: string | null) => void;
    setCodexStatus: (status: CodexStatus) => void;
    setCodexTokenUsage: (usage: CodexTokenUsage) => void;
    setRealtimeUsage: (usage: { usage: RealtimeUsage; costUsd: number }) => void;
    setError: (message: LocOrText | null) => void;
    clearLogs: () => void;
}

const newId = (() => {
    let n = 0;
    return (): string => `${Date.now()}-${++n}`;
})();

export const useSessionStore = create<SessionStore>((set) => ({
    state: "idle",
    statusMessage: null,
    transcript: [],
    progressLog: [],
    approvalNotices: [],
    serverSettings: null,
    codexThreadId: null,
    codexTurnId: null,
    codexStatus: null,
    codexTokenUsage: null,
    realtimeUsage: null,
    sessionId: null,
    logFile: null,
    error: null,

    setState: (state, message) =>
        set({
            state,
            statusMessage: message ?? null,
            error: state === "error" ? (message ?? null) : null,
        }),

    appendTranscript: (role, text) =>
        set((s) => {
            // Merge consecutive deltas of the same role into one line for
            // readability. A new line starts when the previous line was
            // marked final, or when the role flips.
            const last = s.transcript.at(-1);
            if (last && last.role === role) {
                const merged: TranscriptLine = { ...last, text: last.text + text };
                return { transcript: [...s.transcript.slice(0, -1), merged] };
            }
            return {
                transcript: [
                    ...s.transcript,
                    { id: newId(), role, text, timestamp: Date.now() },
                ].slice(-500),
            };
        }),

    appendProgress: (body, level, streaming) =>
        set((s) => {
            // Merge consecutive streaming deltas of the same level into one
            // line so Codex's character-by-character text output reads as a
            // single growing sentence instead of dozens of 1-token rows.
            const last = s.progressLog.at(-1);
            if (
                streaming &&
                last &&
                last.streaming &&
                last.level === level &&
                "text" in last.body &&
                "text" in body
            ) {
                const merged: ProgressLine = {
                    ...last,
                    body: { text: last.body.text + body.text },
                };
                return { progressLog: [...s.progressLog.slice(0, -1), merged] };
            }
            return {
                progressLog: [
                    ...s.progressLog,
                    { id: newId(), body, level, streaming, timestamp: Date.now() },
                ].slice(-500),
            };
        }),

    appendApprovalNotice: ({ summary, kind, detail }) =>
        set((s) => ({
            approvalNotices: [
                ...s.approvalNotices,
                { id: newId(), summary, kind, detail, timestamp: Date.now() },
            ].slice(-50),
        })),

    setServerSettings: (settings, codexThreadId, sessionId, logFile) =>
        set({
            serverSettings: settings,
            codexThreadId: codexThreadId ?? null,
            sessionId: sessionId ?? null,
            logFile: logFile ?? null,
        }),

    setCodexTurnId: (codexTurnId) => set({ codexTurnId }),

    setCodexStatus: (codexStatus) => set({ codexStatus }),

    setCodexTokenUsage: (codexTokenUsage) => set({ codexTokenUsage }),

    setRealtimeUsage: (realtimeUsage) => set({ realtimeUsage }),

    setError: (error) => set({ error }),

    clearLogs: () =>
        set({
            transcript: [],
            progressLog: [],
            approvalNotices: [],
            codexTurnId: null,
            codexStatus: null,
            codexTokenUsage: null,
            realtimeUsage: null,
        }),
}));

export interface SettingsStore extends SessionSettings {
    setSetting: <K extends keyof SessionSettings>(key: K, value: SessionSettings[K]) => void;
    reset: () => void;
}

const DEFAULTS: SessionSettings = {
    voiceProvider: "openai",
    model: "gpt-realtime-2",
    voice: "marin",
    instructionsExtra: "",
    transcriptionModel: "gpt-4o-transcribe",
    transcriptionLanguage: "ja",
    // Empty = inherit from ~/.codex/config.toml's model_reasoning_effort.
    codexReasoningEffort: "",
    // Default ON (near_field); server env can override the boot default.
    noiseReduction: "near_field",
};

export const SETTINGS_STORE_PERSIST_NAME = "codex-realtime-voice-agent.settings";

export const useSettingsStore = create<SettingsStore>()(
    persist(
        (set) => ({
            ...DEFAULTS,
            setSetting: (key, value) => set({ [key]: value } as Partial<SessionSettings>),
            reset: () => set({ ...DEFAULTS }),
        }),
        {
            name: SETTINGS_STORE_PERSIST_NAME,
            version: 5,
            // Older clients had a subset of these fields; merge against
            // DEFAULTS so missing keys come back filled in.
            migrate: (persistedState) => {
                const s = (persistedState ?? {}) as Partial<SessionSettings>;
                return { ...DEFAULTS, ...s };
            },
        },
    ),
);
