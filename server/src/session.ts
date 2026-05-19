/**
 * Per-connection orchestrator: ties one browser WebSocket to one OpenAI
 * Realtime session and one Codex thread.
 *
 * Lifecycle (driven by the client):
 *   - Client connects WS → server constructs a `Session` but does not yet
 *     start any backends.
 *   - Client sends `session/start` → `start()` connects Codex bridge,
 *     opens the OpenAI Realtime WS, and emits `session/status: ready`.
 *   - Audio (binary frames) flows in both directions until the client
 *     sends `session/stop` or disconnects.
 *
 * Only one Session is active per server (enforced in index.ts; this class
 * is per-connection regardless).
 */
import { WebSocket as WS } from "ws";
import path from "node:path";
import { CodexBridge, StdioTransport, type ApprovalKind } from "codex-app-server-bridge";
import { GeminiLiveProvider } from "./providers/gemini-live-provider.js";
import { OpenAIRealtimeProvider } from "./providers/openai-realtime-provider.js";
import {
    type VoiceProvider,
    type RealtimeTool,
    type ToolChoice,
    type UsagePayload,
} from "./providers/voice-provider.js";
import { classifyApproval } from "./approval-policy.js";
import { VoiceApprovalCoordinator } from "./voice-approval.js";
import { SessionLogger } from "./session-logger.js";
import {
    normalizeConversationLanguage,
    type ConversationLanguage,
} from "./i18n/conversation-language.js";
import { classifyApprovalUtterance, isUserQuestion } from "./i18n/decision.js";
import { getModelStrings } from "./i18n/model-strings.js";
import { buildSystemInstructions, getVoiceStrings } from "./i18n/voice-strings.js";
import type {
    ClientToServerMessage,
    CodexTokenUsage,
    RealtimeUsage,
    ServerToClientMessage,
    SessionSettings,
    SessionState,
} from "./types/messages.js";

const CODEX_APP_SERVER_ARGS = [
    "app-server",
    "-c",
    "sandbox_mode=danger-full-access",
    "-c",
    "approval_policy=untrusted",
];

function codexTransportCommand(): { command: string; args: string[] } {
    if (process.platform !== "win32") {
        return { command: "codex", args: CODEX_APP_SERVER_ARGS };
    }

    return {
        command: "cmd.exe",
        args: [
            "/d",
            "/s",
            "/c",
            process.env.CODEX_COMMAND ?? "codex.cmd",
            ...CODEX_APP_SERVER_ARGS,
        ],
    };
}

const codexTurnTool: RealtimeTool = {
    type: "function",
    name: "codex_turn",
    description:
        "Send a natural-language coding/file/command task to the Codex sub-agent. The function blocks until Codex finishes the entire turn. Returns the final text result.",
    parameters: {
        type: "object",
        properties: {
            message: {
                type: "string",
                description: "What you want Codex to do, as a single natural-language sentence.",
            },
        },
        required: ["message"],
    },
};

const supportsPreamble = (model: string): boolean => /^gpt-realtime-2\b/.test(model);

const defaultVoiceFor = (model: string): string =>
    /^gpt-realtime\b/.test(model) ? "marin" : "alloy";
const defaultGeminiVoiceFor = (): string => "Kore";
const isGeminiModel = (model: string): boolean => /^gemini-/.test(model);
const isGeminiVoice = (voice: string): boolean => /^[A-Z]/.test(voice);

const DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS = 60_000;
let didWarnInvalidCodexTurnIdleTimeout = false;

// Per-1M-token rates in USD. Defaults are gpt-realtime-2 from
// https://developers.openai.com/api/docs/pricing — override in `.env`
// with REALTIME_RATE_*_PER_M if you use a different Realtime model
// (e.g. gpt-realtime-mini, gpt-realtime-1.5).
const DEFAULT_REALTIME_RATES = {
    inputTextPerM: 4,
    inputAudioPerM: 32,
    inputCachedTextPerM: 0.4,
    inputCachedAudioPerM: 0.4,
    outputTextPerM: 24,
    outputAudioPerM: 64,
};

const readPositiveRate = (envName: string, fallback: number): number => {
    const raw = process.env[envName];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const REALTIME_RATES = {
    inputTextPerM: readPositiveRate(
        "REALTIME_RATE_INPUT_TEXT_PER_M",
        DEFAULT_REALTIME_RATES.inputTextPerM,
    ),
    inputAudioPerM: readPositiveRate(
        "REALTIME_RATE_INPUT_AUDIO_PER_M",
        DEFAULT_REALTIME_RATES.inputAudioPerM,
    ),
    inputCachedTextPerM: readPositiveRate(
        "REALTIME_RATE_INPUT_CACHED_TEXT_PER_M",
        DEFAULT_REALTIME_RATES.inputCachedTextPerM,
    ),
    inputCachedAudioPerM: readPositiveRate(
        "REALTIME_RATE_INPUT_CACHED_AUDIO_PER_M",
        DEFAULT_REALTIME_RATES.inputCachedAudioPerM,
    ),
    outputTextPerM: readPositiveRate(
        "REALTIME_RATE_OUTPUT_TEXT_PER_M",
        DEFAULT_REALTIME_RATES.outputTextPerM,
    ),
    outputAudioPerM: readPositiveRate(
        "REALTIME_RATE_OUTPUT_AUDIO_PER_M",
        DEFAULT_REALTIME_RATES.outputAudioPerM,
    ),
};

const zeroRealtimeUsage = (): RealtimeUsage => ({
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputTextTokens: 0,
    inputAudioTokens: 0,
    inputCachedTokens: 0,
    inputCachedTextTokens: 0,
    inputCachedAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
    outputReasoningTokens: 0,
});

const addRealtimeUsage = (total: RealtimeUsage, delta: UsagePayload): RealtimeUsage => ({
    totalTokens: total.totalTokens + delta.totalTokens,
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    inputTextTokens: total.inputTextTokens + delta.inputTextTokens,
    inputAudioTokens: total.inputAudioTokens + delta.inputAudioTokens,
    inputCachedTokens: total.inputCachedTokens + delta.inputCachedTokens,
    inputCachedTextTokens: total.inputCachedTextTokens + delta.inputCachedTextTokens,
    inputCachedAudioTokens: total.inputCachedAudioTokens + delta.inputCachedAudioTokens,
    outputTextTokens: total.outputTextTokens + delta.outputTextTokens,
    outputAudioTokens: total.outputAudioTokens + delta.outputAudioTokens,
    outputReasoningTokens: total.outputReasoningTokens + delta.outputReasoningTokens,
});

const calculateRealtimeCostUsd = (usage: RealtimeUsage): number => {
    // input_token_details.text_tokens already includes cached_tokens_details.text_tokens;
    // subtract to get the non-cached portion before applying the regular rate.
    const inputTextNonCached = Math.max(0, usage.inputTextTokens - usage.inputCachedTextTokens);
    const inputAudioNonCached = Math.max(0, usage.inputAudioTokens - usage.inputCachedAudioTokens);
    return (
        (inputTextNonCached * REALTIME_RATES.inputTextPerM +
            inputAudioNonCached * REALTIME_RATES.inputAudioPerM +
            usage.inputCachedTextTokens * REALTIME_RATES.inputCachedTextPerM +
            usage.inputCachedAudioTokens * REALTIME_RATES.inputCachedAudioPerM +
            usage.outputTextTokens * REALTIME_RATES.outputTextPerM +
            usage.outputAudioTokens * REALTIME_RATES.outputAudioPerM) /
        1_000_000
    );
};

const readCodexTurnIdleTimeoutMs = (): number => {
    const raw = process.env.CODEX_TURN_IDLE_TIMEOUT_MS;
    if (raw === undefined) return DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS;

    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;

    if (!didWarnInvalidCodexTurnIdleTimeout) {
        didWarnInvalidCodexTurnIdleTimeout = true;
        console.warn(
            `[session] invalid CODEX_TURN_IDLE_TIMEOUT_MS=${JSON.stringify(
                raw,
            )}; using default ${DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS}`,
        );
    }
    return DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS;
};

type NotificationSubscription = { dispose: () => void };

type NotificationSource = {
    onNotification: (
        method: string,
        handler: (params: unknown) => void,
    ) => NotificationSubscription;
};

type CodexBridgeLike = {
    client: NotificationSource;
    connect: () => Promise<void>;
    startThread: (args: never) => Promise<{ thread: { id: string } }>;
    startTurn: (args: never) => AsyncIterable<{
        type: string;
        [key: string]: unknown;
    }>;
    interruptTurn?: (args: { threadId: string; turnId: string }) => Promise<unknown>;
    close: () => Promise<void>;
    onNotification?: NotificationSource["onNotification"];
};

type RealtimeProviderFactoryArgs = {
    voiceProvider: "openai" | "gemini";
    apiKey: string;
    geminiApiKey?: string;
    model: string;
    voice: string;
    instructions: string;
    tools: RealtimeTool[];
    toolChoice: ToolChoice;
    transcriptionModel: string;
    transcriptionLanguage: string;
    noiseReduction: string;
    logger: SessionLogger;
};

export interface SessionDeps {
    apiKey: string;
    geminiApiKey?: string;
    defaultModel: string;
    defaultVoice: string;
    defaultGeminiModel: string;
    codexCwd: string;
    logsDir: string;
    createBridge?: (config: ConstructorParameters<typeof CodexBridge>[0]) => CodexBridgeLike;
    createRealtimeProvider?: (args: RealtimeProviderFactoryArgs) => VoiceProvider;
}

export class Session {
    readonly #deps: SessionDeps;
    readonly #ws: WS;
    #state: SessionState = "idle";
    #settings: SessionSettings;
    #activeConversationLanguage: ConversationLanguage = "auto";

    get activeConversationLanguage(): ConversationLanguage {
        return this.#activeConversationLanguage;
    }

    #bridge: CodexBridgeLike | null = null;
    #tokenUsageSub: NotificationSubscription | null = null;
    #transportSubs: NotificationSubscription[] = [];
    #stoppingGracefully = false;
    #transportDeadReported = false;
    #stopPromise: Promise<void> | null = null;
    /** FIFO chain that serialises voice approval escalations. Codex can
     *  fire several `approval-requested` callbacks at the same instant
     *  (batched tool calls); the coordinator only supports one in-flight
     *  escalation, so each is asked strictly one after the other instead
     *  of the 2nd+ being auto-refused. */
    #approvalChain: Promise<void> = Promise.resolve();
    /** Number of approval escalations queued or running. While > 0 the
     *  idle timer must not start an idle escalation (Codex is actively
     *  producing approval requests — it is not idle — and a new escalation
     *  would collide with the queued one). */
    #approvalDepth = 0;
    /** Bumped on every `start()`. A queued approval captures the value at
     *  enqueue time; if it differs when the task finally runs the session
     *  was stopped/restarted underneath it, so the stale approval must not
     *  escalate on the new coordinator. */
    #sessionGeneration = 0;
    #threadId: string = "";
    #realtime: VoiceProvider | null = null;
    #voiceCoordinator: VoiceApprovalCoordinator | null = null;
    #responseActive = false;
    /** itemId → resolved fileChange metadata (paths + delete flag) tracked from
     *  `item-started` events so the policy callback can look it up when an
     *  approval request arrives without paths. */
    readonly #fileChangeItemMeta = new Map<string, { paths: string[]; hasDelete: boolean }>();
    #turnInFlight = false;
    /** After barge-in we cancel the active response, but late-arriving
     *  `output_audio.delta` events from OpenAI can still trickle in for the
     *  cancelled response. Suppress them until the next `response.created`
     *  so the browser's playback queue (which we just told to flush) doesn't
     *  immediately refill with stale audio. */
    #suppressAudio = false;
    /** Wallclock ms at which the in-flight assistant response started
     *  producing audio. Used to compute how much of it the user actually
     *  heard before barging in. */
    #responseStartedAt = 0;
    /** item_id of the assistant message currently being spoken (if any).
     *  Captured from `response.output_item.added`. */
    #activeAssistantItemId: string | null = null;
    readonly #logger: SessionLogger;
    readonly #turnIdleTimeoutMs: number;
    #idleEscalationActive = false;
    #cumulativeRealtimeUsage: RealtimeUsage = zeroRealtimeUsage();

    constructor(deps: SessionDeps, ws: WS) {
        this.#deps = deps;
        this.#ws = ws;
        const envEffort = (process.env.CODEX_REASONING_EFFORT ?? "").trim().toLowerCase();
        const envNoise = (process.env.OPENAI_INPUT_NOISE_REDUCTION ?? "").trim().toLowerCase();
        this.#settings = {
            voiceProvider: "openai",
            model: deps.defaultModel,
            voice: deps.defaultVoice,
            instructionsExtra: "",
            transcriptionModel: "gpt-4o-transcribe",
            transcriptionLanguage: "ja",
            codexReasoningEffort:
                envEffort === "low" || envEffort === "medium" || envEffort === "high"
                    ? envEffort
                    : "",
            // Default ON (near_field) — most users talk fairly close to the
            // mic and noise reduction also sharpens VAD/turn detection.
            // Override via .env or the SettingsPanel.
            noiseReduction:
                envNoise === "near_field" || envNoise === "far_field" || envNoise === "off"
                    ? envNoise
                    : "near_field",
        };
        this.#logger = new SessionLogger(deps.logsDir);
        this.#turnIdleTimeoutMs = readCodexTurnIdleTimeoutMs();
        this.#logger.log("session", "ctor", { logFile: this.#logger.file });
        console.error(`[session] id=${this.#logger.id} log=${this.#logger.file}`);
        ws.on("message", (data, isBinary) => this.#onWsMessage(data, isBinary));
        ws.on("close", () => this.#onWsClose());
        ws.on("error", (err) => this.#emitError(`websocket error: ${err.message}`, false));
        this.#emitSettings();
        this.#setState("idle");
    }

    /** Process an incoming WebSocket frame from the browser. */
    #onWsMessage = (data: WS.RawData, isBinary: boolean): void => {
        if (isBinary) {
            // Binary frame = raw PCM int16 LE mono audio from the mic.
            // The sample rate matches the active provider's inputSampleRate.
            if (this.#realtime && this.#state === "active") {
                this.#realtime.appendAudio(Buffer.from(data as Buffer));
            }
            return;
        }
        const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString();
        let parsed: ClientToServerMessage;
        try {
            parsed = JSON.parse(text) as ClientToServerMessage;
        } catch {
            this.#emitError("invalid JSON from client", false);
            return;
        }
        this.#logger.log("ws.in", parsed.type, parsed);
        switch (parsed.type) {
            case "session/start":
                if (parsed.settings) this.#settings = { ...this.#settings, ...parsed.settings };
                void this.start();
                return;
            case "session/stop":
                void this.stop();
                return;
            case "settings/update":
                this.#settings = { ...this.#settings, ...parsed.settings };
                this.#emitSettings();
                return;
        }
    };

    #onWsClose = (): void => {
        void this.stop();
    };

    start = async (): Promise<void> => {
        if (this.#state !== "idle" && this.#state !== "stopped" && this.#state !== "error") {
            return;
        }
        this.#activeConversationLanguage = normalizeConversationLanguage(
            this.#settings.transcriptionLanguage,
        );
        this.#stopPromise = null;
        this.#stoppingGracefully = false;
        this.#sessionGeneration += 1;
        this.#transportDeadReported = false;
        this.#threadId = "";
        this.#responseActive = false;
        this.#suppressAudio = false;
        this.#turnInFlight = false;
        this.#responseStartedAt = 0;
        this.#activeAssistantItemId = null;
        this.#idleEscalationActive = false;
        this.#cumulativeRealtimeUsage = zeroRealtimeUsage();
        this.#fileChangeItemMeta.clear();
        this.#setState("connecting");
        try {
            // ----- Codex bridge -----
            // Reasoning effort is no longer pinned at app-server boot — we
            // pass it per-turn via `startTurn({ effort })` so it can be
            // changed from the UI without restarting Codex.
            const transport = new StdioTransport({
                ...codexTransportCommand(),
                cwd: this.#deps.codexCwd,
            });
            const bridgeConfig: ConstructorParameters<typeof CodexBridge>[0] = {
                transport,
                clientInfo: {
                    name: "codex_realtime_voice_agent",
                    title: "Codex Realtime Voice Agent",
                    version: "0.0.1",
                },
                approvalTimeoutMs: 0,
                onApprovalRequested: async ({ kind, method, params }) => {
                    this.#logger.log("bridge", "approval-requested", { kind, method, params });
                    if (this.#idleEscalationActive && this.#voiceCoordinator?.isEscalating) {
                        this.#voiceCoordinator.abort(
                            "approval-requested takes priority over idle escalation",
                        );
                    }
                    let resolvedPaths: string[] | undefined;
                    let hasDelete: boolean | undefined;
                    if (kind === "fileChange") {
                        const p = params as { itemId?: string };
                        if (typeof p.itemId === "string") {
                            const meta = this.#fileChangeItemMeta.get(p.itemId);
                            if (meta) {
                                resolvedPaths = meta.paths;
                                hasDelete = meta.hasDelete;
                            }
                        }
                    }
                    const strings = getVoiceStrings(this.#activeConversationLanguage);
                    const policy = classifyApproval(
                        {
                            kind: kind as ApprovalKind,
                            method,
                            params,
                            cwd: this.#deps.codexCwd,
                            resolvedPaths,
                            hasDelete,
                        },
                        strings,
                    );
                    this.#logger.log("policy", "verdict", {
                        verdict: policy.verdict,
                        summary: policy.summary,
                        reason: policy.reason,
                        resolvedPaths,
                        hasDelete,
                    });
                    this.#progress(`policy: ${policy.verdict} — ${policy.summary}`);
                    if (policy.verdict === "auto-accept") return { decision: "accept" };
                    if (policy.verdict === "auto-refuse") return { decision: "refuse" };
                    if (!this.#voiceCoordinator) return { decision: "refuse" };
                    const approvalDetail = this.#buildApprovalDetail(
                        String(kind),
                        params,
                        resolvedPaths,
                    );
                    // Serialise: Codex may fire several approval-requested
                    // callbacks at once. Ask them one at a time instead of
                    // letting the 2nd+ collide with the in-flight escalation
                    // (which previously threw → auto-refuse). The notice +
                    // response-cancel run when this item is actually voiced,
                    // not all up front, so they don't disrupt the prior one.
                    // Count this approval as outstanding *synchronously* (it
                    // is queued, maybe not yet running) so the idle timer
                    // does not start an idle escalation in the gap while a
                    // queued item is mid `cancelResponse()` (isEscalating is
                    // briefly false there) and collide with its escalate().
                    this.#approvalDepth += 1;
                    const approvalGen = this.#sessionGeneration;
                    return this.#serializeApproval(async () => {
                        try {
                            const coordinator = this.#voiceCoordinator;
                            // Stale when the session was stopped (and maybe
                            // restarted) underneath this queued item:
                            //  - `#stoppingGracefully` is set synchronously at
                            //    the top of `#runStop` (before `#voiceCoordinator`
                            //    is nulled) — without it a queued item could
                            //    grab the not-yet-nulled coordinator after the
                            //    in-flight one was aborted and escalate on a
                            //    closing Realtime → hang.
                            //  - generation mismatch / coordinator swap means a
                            //    *new* session started; this stale approval
                            //    must not escalate on the fresh coordinator.
                            const isStale = (): boolean =>
                                this.#stoppingGracefully ||
                                this.#sessionGeneration !== approvalGen ||
                                this.#voiceCoordinator !== coordinator;
                            if (!coordinator || isStale()) {
                                return { decision: "refuse" as const };
                            }
                            this.#emitApprovalNotice(policy.summary, String(kind));
                            // The agent may be mid-sentence on a progress
                            // narration. Force-stop it (cancel + flush the
                            // browser playback queue + truncate) so the
                            // approval notice can be spoken on a clear floor.
                            if (this.#responseActive && this.#realtime) {
                                this.#logger.log("session", "cancel-active-response-for-approval");
                                await this.#interruptPlayback();
                                this.#logger.log("session", "response-idle-after-cancel", {
                                    stillActive: this.#responseActive,
                                });
                            }
                            // Re-check after the await: `stop()` may have run
                            // during it while no pending escalation existed
                            // yet (so `coordinator.abort()` was a no-op).
                            // Escalating now on a closed Realtime would hang.
                            if (isStale()) {
                                return { decision: "refuse" as const };
                            }
                            try {
                                this.#logger.log("voice", "escalate-start", {
                                    summary: policy.summary,
                                    detail: approvalDetail,
                                });
                                const d = await coordinator.escalate(
                                    policy.summary,
                                    approvalDetail,
                                );
                                this.#logger.log("voice", "escalate-resolved", { decision: d });
                                return { decision: d };
                            } catch (err) {
                                this.#logger.log("voice", "escalate-rejected", {
                                    error: (err as Error).message,
                                });
                                return { decision: "refuse" as const };
                            }
                        } finally {
                            this.#approvalDepth -= 1;
                            if (this.#approvalDepth < 0) {
                                // Strictly impossible (one +1 per enqueue,
                                // one -1 here); log + clamp so a future
                                // imbalance is visible instead of silently
                                // suppressing the idle timer forever.
                                this.#logger.log("session", "approval-depth-underflow", {
                                    depth: this.#approvalDepth,
                                });
                                this.#approvalDepth = 0;
                            }
                        }
                    });
                },
            };
            this.#bridge = this.#deps.createBridge
                ? this.#deps.createBridge(bridgeConfig)
                : new CodexBridge(bridgeConfig);
            const errSub = transport.onError((err) => this.#onCodexTransportError(err));
            const closeSub = transport.onClose(() => this.#onCodexTransportClose());
            this.#transportSubs.push(errSub, closeSub);
            const notificationSource =
                "onNotification" in this.#bridge
                    ? (this.#bridge as unknown as NotificationSource)
                    : this.#bridge.client;
            this.#tokenUsageSub = notificationSource.onNotification(
                "thread/tokenUsage/updated",
                (params) => {
                    if (params && typeof params === "object" && "tokenUsage" in params) {
                        const tu = (params as { tokenUsage: unknown })
                            .tokenUsage as CodexTokenUsage;
                        this.#logger.log("bridge", "tokenUsage", tu);
                        this.#send({ type: "codex/tokenUsage", tokenUsage: tu });
                    }
                },
            );
            await this.#bridge.connect();
            const startResult = (await this.#bridge.startThread({
                cwd: this.#deps.codexCwd,
            } as never)) as { thread: { id: string } };
            this.#threadId = startResult.thread.id;
            this.#emitSettings();
            this.#progress(`Codex thread ${this.#threadId} started`);

            // ----- Voice provider -----
            const voiceProvider = this.#settings.voiceProvider ?? "openai";
            const model =
                voiceProvider === "gemini" && !isGeminiModel(this.#settings.model)
                    ? this.#deps.defaultGeminiModel
                    : this.#settings.model;
            const configuredVoice = this.#settings.voice;
            const voice =
                voiceProvider === "gemini"
                    ? configuredVoice && isGeminiVoice(configuredVoice)
                        ? configuredVoice
                        : defaultGeminiVoiceFor()
                    : configuredVoice || defaultVoiceFor(model);
            const instructions =
                buildSystemInstructions(this.#activeConversationLanguage) +
                (this.#settings.instructionsExtra ? "\n\n" + this.#settings.instructionsExtra : "");
            const tools = [codexTurnTool];
            if (this.#deps.createRealtimeProvider) {
                this.#realtime = this.#deps.createRealtimeProvider({
                    voiceProvider,
                    apiKey: this.#deps.apiKey,
                    geminiApiKey: this.#deps.geminiApiKey,
                    model,
                    voice,
                    instructions,
                    tools,
                    toolChoice: "auto",
                    transcriptionModel: this.#settings.transcriptionModel,
                    transcriptionLanguage: this.#settings.transcriptionLanguage,
                    noiseReduction: this.#settings.noiseReduction,
                    logger: this.#logger,
                });
            } else if (voiceProvider === "gemini") {
                if (!this.#deps.geminiApiKey) {
                    throw new Error("GEMINI_API_KEY is required when voiceProvider=gemini");
                }
                this.#realtime = new GeminiLiveProvider(
                    this.#deps.geminiApiKey,
                    model || this.#deps.defaultGeminiModel,
                    {
                        instructions,
                        voice,
                        tools,
                        toolChoice: "auto",
                    },
                    this.#logger,
                );
            } else {
                this.#realtime = new OpenAIRealtimeProvider(
                    this.#deps.apiKey,
                    model,
                    {
                        instructions,
                        voice,
                        tools,
                        toolChoice: "auto",
                        transcriptionModel: this.#settings.transcriptionModel,
                        transcriptionLanguage: this.#settings.transcriptionLanguage,
                        noiseReduction: this.#settings.noiseReduction,
                    },
                    this.#logger,
                );
            }
            this.#voiceCoordinator = new VoiceApprovalCoordinator(
                this.#realtime,
                {
                    onInterrupt: () => this.#interruptPlayback(),
                },
                getVoiceStrings(this.#activeConversationLanguage),
            );

            this.#realtime.on("audio", (chunk) => {
                if (this.#suppressAudio) return;
                if (this.#ws.readyState === WS.OPEN) this.#ws.send(chunk, { binary: true });
            });
            this.#realtime.on("transcript", (text, role) => {
                this.#send({ type: "transcript", role, text, final: false });
                // While an escalation is in flight, classify the user's
                // completed answer deterministically off the transcript and
                // drive the coordinator. The model is never asked to decide.
                // Gated on `isEscalating` (the whole window, not just the
                // post-question phase) so an answer the user barges in with
                // *while the notice/question is still being spoken* is not
                // lost. `transcript` for role==="user" fires once per
                // finished utterance (input_audio_transcription.completed).
                const coordinator = this.#voiceCoordinator;
                if (role === "user" && coordinator?.isEscalating) {
                    const verdict = classifyApprovalUtterance(
                        text,
                        this.#activeConversationLanguage,
                    );
                    if (verdict === "accept") {
                        this.#logger.log("voice", "approval-utterance", { text, kind: "accept" });
                        coordinator.accept();
                    } else if (verdict === "refuse") {
                        this.#logger.log("voice", "approval-utterance", { text, kind: "refuse" });
                        coordinator.refuse();
                    } else if (isUserQuestion(text, this.#activeConversationLanguage)) {
                        this.#logger.log("voice", "approval-utterance", {
                            text,
                            kind: "question",
                        });
                        coordinator.clarify(text);
                    } else {
                        this.#logger.log("voice", "approval-utterance", {
                            text,
                            kind: "ambiguous",
                        });
                        coordinator.ambiguous();
                    }
                }
            });
            this.#realtime.on("usage", (usage) => {
                this.#cumulativeRealtimeUsage = addRealtimeUsage(
                    this.#cumulativeRealtimeUsage,
                    usage,
                );
                const costUsd = calculateRealtimeCostUsd(this.#cumulativeRealtimeUsage);
                this.#logger.log("session", "realtime-tokenUsage", {
                    usage: this.#cumulativeRealtimeUsage,
                    costUsd,
                });
                this.#send({
                    type: "realtime/tokenUsage",
                    usage: this.#cumulativeRealtimeUsage,
                    costUsd,
                });
            });
            this.#realtime.on("error", (err) => {
                // `response_cancel_not_active` fires whenever our barge-in
                // race kicks in after the response has already finished.
                // It's harmless and noisy — drop it from the progress log.
                // The raw event is still in the JSONL log for inspection.
                if (err.message.includes("response_cancel_not_active")) return;
                this.#progress(`realtime error: ${err.message}`, "error");
            });
            this.#realtime.on("raw", (event) => {
                const t = event.type as string | undefined;
                if (t === "response.created") {
                    this.#responseActive = true;
                    this.#responseStartedAt = Date.now();
                    this.#activeAssistantItemId = null;
                    // A fresh response starts producing audio; remove any
                    // suppression we set during the previous barge-in.
                    this.#suppressAudio = false;
                }
                if (t === "response.output_item.added" || t === "conversation.item.added") {
                    const item = (event.item ?? {}) as {
                        id?: string;
                        type?: string;
                        role?: string;
                    };
                    if (
                        item.type === "message" &&
                        item.role === "assistant" &&
                        typeof item.id === "string"
                    ) {
                        this.#activeAssistantItemId = item.id;
                    }
                }
                if (t === "response.done" || t === "response.cancelled") {
                    this.#responseActive = false;
                    this.#activeAssistantItemId = null;
                }
                // Barge-in: the moment server_vad hears the user start
                // talking, drop everything queued for playback. We do this
                // even when `responseActive` is false because the previous
                // response can be done on the server side while the browser
                // is still draining its playback queue — the user hears the
                // agent talking even after our `response.done` already fired.
                // History truncate only makes sense when a response is
                // actually in flight, so that stays gated.
                if (t === "input_audio_buffer.speech_started") {
                    const itemId = this.#activeAssistantItemId;
                    // approximate client-side network/jitter offset
                    const heardMs = Math.max(0, Date.now() - this.#responseStartedAt - 150);
                    this.#logger.log("session", "barge-in", {
                        responseActive: this.#responseActive,
                        itemId,
                        heardMs,
                    });
                    if (this.#responseActive) {
                        if (itemId) this.#realtime?.truncateItem(itemId, heardMs);
                    }
                    this.#suppressAudio = true;
                    this.#send({ type: "audio/flush" });
                }
            });
            this.#realtime.on("functionCall", (call) => {
                this.#logger.log("session", "function-call", {
                    name: call.name,
                    callId: call.callId,
                    arguments: call.arguments,
                });
                void this.#handleFunctionCall(call);
            });

            await this.#realtime.connect();
            this.#progress(
                `Realtime session open (provider=${voiceProvider}, model=${model}, voice=${voice}, inputRate=${this.#realtime.inputSampleRate}, preamble=${voiceProvider === "openai" && supportsPreamble(model) ? "on" : "off"})`,
            );

            this.#setState("active");
        } catch (err) {
            this.#emitError(`session start failed: ${(err as Error).message}`, true);
            await this.stop();
        }
    };

    stop = async (): Promise<void> => {
        if (this.#stopPromise) return this.#stopPromise;
        if (this.#state === "stopped" || this.#state === "idle") return;
        this.#stopPromise = this.#runStop();
        return this.#stopPromise;
    };

    #runStop = async (): Promise<void> => {
        try {
            this.#stoppingGracefully = true;
            this.#setState("stopping");
            this.#voiceCoordinator?.abort("session stopping");
            try {
                this.#tokenUsageSub?.dispose();
            } catch {
                /* ignore */
            }
            for (const sub of this.#transportSubs) {
                try {
                    sub.dispose();
                } catch {
                    /* ignore */
                }
            }
            this.#transportSubs = [];
            try {
                this.#realtime?.close();
            } catch {
                /* ignore */
            }
            try {
                await this.#bridge?.close();
            } catch {
                /* ignore */
            }
            this.#realtime = null;
            this.#bridge = null;
            this.#tokenUsageSub = null;
            this.#voiceCoordinator = null;
            this.#fileChangeItemMeta.clear();
            this.#setState("stopped");
            this.#logger.log("session", "stopped");
            this.#logger.close();
        } finally {
            this.#stopPromise = null;
        }
    };

    #onCodexTransportError(err: Error): void {
        this.#logger.log("transport", "error", { message: err.message, stack: err.stack });
        this.#progress(`[Codex Transport] エラー: ${err.message}`, "error");
        this.#onCodexTransportClose();
    }

    #onCodexTransportClose(): void {
        if (this.#stoppingGracefully) {
            this.#logger.log("transport", "close", { graceful: true });
            return;
        }
        if (this.#transportDeadReported) {
            this.#logger.log("transport", "unexpected-close-duplicate");
            return;
        }
        this.#logger.log("transport", "unexpected-close");
        this.#progress("[Codex Transport] プロセスが予期せず終了しました", "error");
        this.#transportDeadReported = true;
        this.#emitError("Codex bridge transport closed unexpectedly", true);
        void this.stop();
    }

    #handleFunctionCall = async (call: {
        name: string;
        callId: string;
        arguments: string;
    }): Promise<void> => {
        if (!this.#realtime) return;
        if (call.name === "codex_turn") {
            if (this.#turnInFlight) {
                this.#realtime.sendFunctionCallOutput(
                    call.callId,
                    JSON.stringify({
                        status: "error",
                        message: getModelStrings(this.#activeConversationLanguage)
                            .turnAlreadyRunning,
                    }),
                );
                this.#realtime.createResponse();
                return;
            }
            this.#turnInFlight = true;
            try {
                const parsed = JSON.parse(call.arguments) as { message?: string };
                const message = parsed.message ?? "";
                const result = await this.#runCodexTurn(message);
                this.#realtime.sendFunctionCallOutput(call.callId, JSON.stringify(result));
            } catch (err) {
                this.#realtime.sendFunctionCallOutput(
                    call.callId,
                    JSON.stringify({
                        status: "error",
                        message: getModelStrings(this.#activeConversationLanguage).rawError(
                            String(err),
                        ),
                    }),
                );
            } finally {
                this.#turnInFlight = false;
                // While Codex was running, the user may have spoken something
                // and triggered a VAD-driven response. response.create would
                // be rejected with `conversation_already_has_active_response`
                // and the Codex result would never be narrated. Cancel the
                // in-flight response so we can immediately speak the outcome.
                if (this.#responseActive) {
                    this.#logger.log("session", "cancel-active-response-for-codex-result");
                    this.#realtime.cancelResponse();
                    await this.#waitForResponseIdle(800);
                }
                this.#realtime.createResponse();
            }
            return;
        }
        // Approval decisions are resolved deterministically off the user
        // transcript (see the `transcript` handler) — there is no
        // model-driven approval tool. Any other function call is ignored.
    };

    #buildApprovalDetail = (kind: string, params: unknown, resolvedPaths?: string[]): string => {
        const labels = getVoiceStrings(this.#activeConversationLanguage).approvalDetail;
        const lines = [`${labels.kind}: ${kind}`];
        const p = params as Record<string, unknown>;
        if (kind === "fileChange" && resolvedPaths && resolvedPaths.length > 0) {
            lines.push(
                `${labels.fileTargets}:`,
                ...resolvedPaths.map((filePath) =>
                    path.isAbsolute(filePath)
                        ? filePath
                        : path.resolve(this.#deps.codexCwd, filePath),
                ),
            );
            return lines.join("\n");
        }
        if (kind === "commandExecution") {
            if (typeof p.command === "string") lines.push(`${labels.command}: ${p.command}`);
            if (Array.isArray(p.command)) lines.push(`${labels.command}: ${p.command.join(" ")}`);
            if (typeof p.cwd === "string") lines.push(`${labels.cwd}: ${p.cwd}`);
            if (lines.length > 1) return lines.join("\n");
        }
        const raw = this.#safeStringify(params);
        lines.push(raw.length > 1200 ? `${raw.slice(0, 1200)}...` : raw);
        return lines.join("\n");
    };

    #safeStringify(value: unknown): string {
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    #injectCodexProgress(text: string): void {
        const trimmed = text.trim();
        if (!trimmed || !this.#realtime) return;
        this.#realtime.send({
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: `${getVoiceStrings(this.#activeConversationLanguage).codexProgressPrefix} ${trimmed.slice(0, 200)}`,
                    },
                ],
            },
        });
    }

    #runCodexTurn = async (
        message: string,
    ): Promise<{ status: "completed" | "error"; text: string; message?: string }> => {
        const modelStrings = getModelStrings(this.#activeConversationLanguage);
        if (!this.#bridge) {
            return { status: "error", text: "", message: modelStrings.bridgeNotConnected };
        }
        const accum: string[] = [];
        let pendingNarrative = "";
        const flushNarrativeIfReady = (force: boolean): void => {
            if (!pendingNarrative.trim()) return;
            const lastBoundary = Math.max(
                pendingNarrative.lastIndexOf("。"),
                pendingNarrative.lastIndexOf("\n"),
            );
            let toFlush: string;
            if (force) {
                toFlush = pendingNarrative;
                pendingNarrative = "";
            } else if (lastBoundary >= 0 && pendingNarrative.length >= 40) {
                toFlush = pendingNarrative.slice(0, lastBoundary + 1);
                pendingNarrative = pendingNarrative.slice(lastBoundary + 1);
            } else {
                return;
            }
            this.#injectCodexProgress(toFlush);
        };
        let currentTurnId: string | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let timeoutFired = false;
        let sawTurnCompleted = false;
        let rejectIdle: ((err: Error) => void) | null = null;
        const idleFailure = new Promise<never>((_, reject) => {
            rejectIdle = reject;
        });
        let turnIterator: AsyncIterator<{
            type: string;
            [key: string]: unknown;
        }> | null = null;
        let turnStartedAt: number | null = null;
        let lastEventAt: number | null = null;
        let lastThrottledStatusAt = 0;
        const idleMs = this.#turnIdleTimeoutMs;
        const sendCodexStatus = (text: string, throttle = false): void => {
            const now = Date.now();
            if (throttle) {
                if (now - lastThrottledStatusAt < 500) return;
                lastThrottledStatusAt = now;
            }
            this.#send({ type: "codex/status", text, turnStartedAt, lastEventAt });
        };
        const summarizeItemStarted = (item: unknown): string => {
            const wrap = item as {
                item?: {
                    type?: string;
                    command?: unknown;
                    changes?: Array<{ path?: unknown }>;
                    name?: unknown;
                    server?: unknown;
                    tool?: unknown;
                };
            };
            const inner = wrap?.item;
            if (!inner) return "項目開始: ?";
            const itemType = inner?.type ?? "?";
            if (itemType === "commandExecution") {
                const command = typeof inner.command === "string" ? inner.command : "?";
                return `コマンド実行中: ${command.slice(0, 60)}`;
            }
            if (itemType === "fileChange") {
                const changes = Array.isArray(inner.changes) ? inner.changes : [];
                const firstPath =
                    typeof changes[0]?.path === "string" ? path.basename(changes[0].path) : "?";
                const rest = changes.length > 1 ? ` 外 ${changes.length - 1} 件` : "";
                return `ファイル変更中: ${firstPath}${rest}`;
            }
            if (itemType === "mcpToolCall") {
                const name =
                    typeof inner.name === "string"
                        ? inner.name
                        : typeof inner.tool === "string"
                          ? inner.tool
                          : "?";
                return `MCP tool 実行中: ${name}`;
            }
            return `項目開始: ${itemType}`;
        };
        const bestEffort = (
            op: Promise<unknown> | undefined,
            label: string,
            timeoutMs = 5000,
        ): void => {
            if (!op) return;
            const timer = setTimeout(() => {
                this.#logger.log("session", `${label}-timeout`, { timeoutMs });
            }, timeoutMs);
            op.catch((err: unknown) => {
                this.#logger.log("session", `${label}-error`, { error: String(err) });
            }).finally(() => clearTimeout(timer));
        };
        const clearIdleTimer = (): void => {
            if (!idleTimer) return;
            clearTimeout(idleTimer);
            idleTimer = null;
        };
        const resetIdleTimer = (): void => {
            if (timeoutFired) return;
            clearIdleTimer();
            idleTimer = setTimeout(() => {
                if (timeoutFired) return;
                timeoutFired = true;
                const turnId = currentTurnId;
                this.#logger.log("session", "turn-idle-timeout", { idleMs, turnId });
                const voiceCoordinator = this.#voiceCoordinator;
                // 既存の voice approval (= Codex 由来の approval-requested) が走っている間は、
                // idle timer を「approval 待ちが長引いている」と勘違いさせない。
                // Codex は approval 応答を待っているだけで turn 自体は alive なので無害。
                // `#approvalDepth > 0` はキュー済みだが未開始 (cancelResponse 中で
                // isEscalating が一瞬 false) のものも取りこぼさないため。
                if (!voiceCoordinator || voiceCoordinator.isEscalating || this.#approvalDepth > 0) {
                    this.#logger.log("session", "turn-idle-timeout-skip-escalation");
                    timeoutFired = false;
                    resetIdleTimer();
                    return;
                }
                this.#idleEscalationActive = true;
                void (async () => {
                    try {
                        const summary = `Codex から ${Math.round(
                            idleMs / 1000,
                        )} 秒間応答がありません。中断しますか?`;
                        this.#progress(`[Codex 警告] ${summary} (音声で確認します)`, "warn");
                        const decision = await voiceCoordinator.escalate(summary);
                        this.#idleEscalationActive = false;
                        this.#logger.log("session", "turn-idle-timeout-decision", {
                            decision,
                        });
                        if (decision === "accept") {
                            if (turnId) {
                                bestEffort(
                                    this.#bridge?.interruptTurn?.({
                                        threadId: this.#threadId,
                                        turnId,
                                    }),
                                    "turn-idle-timeout-interrupt",
                                    5000,
                                );
                            }
                            rejectIdle?.(new Error("Codex turn idle timeout (user cancelled)"));
                            rejectIdle = null;
                            return;
                        }
                        timeoutFired = false;
                        resetIdleTimer();
                    } catch (err) {
                        this.#idleEscalationActive = false;
                        this.#logger.log("session", "turn-idle-timeout-escalate-aborted", {
                            error: String(err),
                        });
                        timeoutFired = false;
                        resetIdleTimer();
                    }
                })();
            }, idleMs);
        };
        try {
            const effort = this.#settings.codexReasoningEffort;
            this.#logger.log("bridge", "turn-start", { message, effort });
            this.#progress(`→ Codex: ${message}`, "info");
            const turnArgs: Record<string, unknown> = {
                threadId: this.#threadId,
                input: [{ type: "text", text: message, text_elements: [] }],
                cwd: this.#deps.codexCwd,
            };
            if (effort === "low" || effort === "medium" || effort === "high") {
                turnArgs.effort = effort;
            }
            resetIdleTimer();
            turnIterator = this.#bridge.startTurn(turnArgs as never)[Symbol.asyncIterator]();
            while (true) {
                const next = await Promise.race([turnIterator.next(), idleFailure]);
                if (next.done) break;
                const ev = next.value;
                if (this.#idleEscalationActive) {
                    this.#voiceCoordinator?.abort("bridge event resumed");
                }
                resetIdleTimer();
                this.#logger.log("bridge", `event.${ev.type}`, ev);
                lastEventAt = Date.now();
                switch (ev.type) {
                    case "turn-started": {
                        turnStartedAt = Date.now();
                        sendCodexStatus("ターン開始");
                        // bridge payload shape is { type, turn: { threadId, turn: { id, ... } } }
                        // — the inner `turn` is the real Turn object.
                        const wrap = ev.turn as { turn?: { id?: unknown } } | undefined;
                        const turnId = typeof wrap?.turn?.id === "string" ? wrap.turn.id : null;
                        currentTurnId = turnId;
                        this.#send({ type: "codex/turn", turnId });
                        break;
                    }
                    case "turn-completed":
                        sendCodexStatus("ターン完了");
                        sawTurnCompleted = true;
                        this.#send({ type: "codex/turn", turnId: null });
                        break;
                    case "text-delta":
                        if (ev.kind === "text") {
                            sendCodexStatus("テキスト生成中", true);
                        } else if (ev.kind === "reasoning" || ev.kind === "reasoning-summary") {
                            sendCodexStatus("推論中", true);
                        } else if (ev.kind === "plan") {
                            sendCodexStatus("計画立案中");
                        }
                        if (ev.kind === "text" && typeof ev.text === "string") {
                            accum.push(ev.text);
                            this.#progress(ev.text, "info", true);
                            pendingNarrative += ev.text;
                            flushNarrativeIfReady(false);
                        }
                        break;
                    case "item-output-delta":
                        sendCodexStatus("出力ストリーム中", true);
                        break;
                    case "item-started":
                    case "item-completed": {
                        const wrap = ev.item as {
                            item?: {
                                type?: string;
                                id?: string;
                                command?: unknown;
                                changes?: Array<{ path?: unknown; kind?: { type?: string } }>;
                            };
                        };
                        const inner = wrap?.item;
                        sendCodexStatus(
                            ev.type === "item-started"
                                ? summarizeItemStarted(ev.item)
                                : "(項目完了)",
                        );
                        if (
                            ev.type === "item-started" &&
                            inner?.type === "fileChange" &&
                            typeof inner.id === "string" &&
                            Array.isArray(inner.changes)
                        ) {
                            const paths: string[] = [];
                            let hasDelete = false;
                            for (const c of inner.changes) {
                                if (typeof c?.path === "string") paths.push(c.path);
                                if (c?.kind?.type === "delete") hasDelete = true;
                            }
                            this.#fileChangeItemMeta.set(inner.id, { paths, hasDelete });
                        } else if (ev.type === "item-completed" && typeof inner?.id === "string") {
                            this.#fileChangeItemMeta.delete(inner.id);
                        }
                        if (ev.type === "item-completed") flushNarrativeIfReady(true);
                        break;
                    }
                    case "error":
                        sendCodexStatus("エラー (継続)");
                        flushNarrativeIfReady(true);
                        {
                            const errMsg = (ev.error as { message?: unknown })?.message;
                            this.#logger.log("bridge", "non-fatal-error", ev.error);
                            this.#progress(
                                `[Codex 警告] bridge error: ${
                                    typeof errMsg === "string" && errMsg ? errMsg : "(no detail)"
                                }`,
                                "warn",
                            );
                        }
                        break;
                    default:
                        sendCodexStatus(`event: ${ev.type}`);
                        break;
                }
            }
            flushNarrativeIfReady(true);
            if (!sawTurnCompleted) {
                return {
                    status: "error",
                    text: accum.join(""),
                    message: modelStrings.turnExitedBeforeCompleted,
                };
            }
            return { status: "completed", text: accum.join("") };
        } catch (err) {
            flushNarrativeIfReady(true);
            if (timeoutFired) {
                bestEffort(turnIterator?.return?.(), "turn-iterator-return", 2000);
                const message =
                    err instanceof Error &&
                    err.message === "Codex turn idle timeout (user cancelled)"
                        ? modelStrings.idleTimeoutUserCancelled
                        : modelStrings.idleTimeout;
                return { status: "error", text: accum.join(""), message };
            }
            return {
                status: "error",
                text: accum.join(""),
                message: modelStrings.rawError(String(err)),
            };
        } finally {
            clearIdleTimer();
            this.#send({ type: "codex/turn", turnId: null });
            this.#send({
                type: "codex/status",
                text: "待機中",
                turnStartedAt: null,
                lastEventAt: null,
            });
        }
    };

    /** Avoid sending audio while client WebSocket is not open. */
    get responseActive(): boolean {
        return this.#responseActive;
    }

    // ---- helpers ----------------------------------------------------------

    #setState(state: SessionState, message?: string): void {
        const prev = this.#state;
        this.#state = state;
        this.#logger.log("session", "state-change", { from: prev, to: state, message });
        this.#send({ type: "session/status", state, message });
    }

    #emitSettings(): void {
        this.#send({
            type: "settings",
            settings: this.#settings,
            codexThreadId: this.#threadId || undefined,
            sessionId: this.#logger.id,
            logFile: this.#logger.file,
        });
    }

    #emitApprovalNotice(summary: string, kind: string): void {
        this.#send({ type: "approval/notice", summary, kind });
    }

    /** Wait until `responseActive` becomes false, or the timeout fires. */
    #waitForResponseIdle(timeoutMs: number): Promise<void> {
        if (!this.#responseActive) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const start = Date.now();
            const tick = (): void => {
                if (!this.#responseActive) return resolve();
                if (Date.now() - start >= timeoutMs) return resolve();
                setTimeout(tick, 30);
            };
            tick();
        });
    }

    /** Force-stop whatever is being spoken: truncate + cancel the active
     *  response, flush the browser playback queue, suppress trailing audio,
     *  and resolve once the response is idle. Safe to call when nothing is
     *  in flight (cancel of a finished response yields a harmless
     *  `response_cancel_not_active`, which the error handler drops). Used
     *  for the agent-speaking escalation barge-in and as the coordinator's
     *  application-driven interrupt. */
    #interruptPlayback = async (): Promise<void> => {
        if (this.#realtime && this.#responseActive) {
            const itemId = this.#activeAssistantItemId;
            if (itemId) {
                const heardMs = Math.max(0, Date.now() - this.#responseStartedAt - 150);
                this.#realtime.truncateItem(itemId, heardMs);
            }
            this.#realtime.cancelResponse();
        }
        this.#suppressAudio = true;
        this.#send({ type: "audio/flush" });
        await this.#waitForResponseIdle(800);
    };

    /** Run `task` after every previously queued approval escalation has
     *  fully settled. The chain is kept on a never-rejecting promise so a
     *  refused/aborted escalation does not stall the ones behind it. */
    #serializeApproval = <T>(task: () => Promise<T>): Promise<T> => {
        const result = this.#approvalChain.then(task);
        this.#approvalChain = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };

    #emitError(message: string, fatal: boolean): void {
        this.#send({ type: "error", message, fatal });
        if (fatal) this.#setState("error", message);
    }

    #progress(text: string, level: "info" | "warn" | "error" = "info", streaming?: boolean): void {
        this.#send({ type: "codex/progress", text, level, streaming });
    }

    #send(msg: ServerToClientMessage): void {
        if (this.#ws.readyState !== WS.OPEN) return;
        this.#ws.send(JSON.stringify(msg));
    }
}

// Suppress unused warning for ToolChoice (re-exported for future tool_choice tweaks)
export type { ToolChoice };
