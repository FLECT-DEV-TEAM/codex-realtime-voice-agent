/**
 * Minimal OpenAI Realtime API client over WebSocket (GA shape).
 *
 * We use raw `ws` instead of the `openai` SDK helper because:
 *   1. The protocol is small, well-documented, and stable; the SDK adds
 *      indirection without value.
 *   2. We need fine control over `session.update` (dynamic tools / tool_choice)
 *      and direct audio buffer streaming.
 *
 * Protocol reference:
 *   https://platform.openai.com/docs/api-reference/realtime
 *
 * Audio formats are pcm16 (16-bit LE mono 24 kHz, base64-encoded on the wire).
 *
 * Known gotchas (encoded as workarounds below):
 *   - The Beta `OpenAI-Beta: realtime=v1` header is rejected by GA.
 *   - GA session.update requires `session.type: "realtime"` on every update,
 *     not just the first.
 *   - Audio config moved under nested `audio.input` / `audio.output`.
 *   - `modalities` was renamed to `output_modalities`.
 *   - `response.audio.*` events were renamed `response.output_audio.*`.
 *   - `tool_choice: { type:"function", name:"..." }` is unreliably enforced;
 *     trim the tools list to one entry and use `tool_choice: "required"` for
 *     a hard guarantee.
 *   - `response.function_call_arguments.done` does not always include the
 *     function `name`; resolve it from `response.output_item.added` instead.
 */
import WebSocket from "ws";
import type { SessionLogger } from "../session-logger.js";
import {
    VoiceProvider,
    type RealtimeTool,
    type ToolChoice,
    type UsagePayload,
    type VoiceProviderConfig,
} from "./voice-provider.js";

/** Server-VAD config used in the normal (non-escalation) state: VAD both
 *  detects turn boundaries (→ transcription) and auto-creates / auto-
 *  interrupts responses. */
export const DEFAULT_TURN_DETECTION: Record<string, unknown> = {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: true,
    interrupt_response: true,
};

/** Server-VAD config used while a voice approval is in flight. VAD still
 *  detects speech and produces transcripts (so the deterministic yes/no
 *  classifier keeps working) but never auto-creates a competing response
 *  and never auto-interrupts: during an escalation every response.create /
 *  response.cancel is application-driven so the approval question can never
 *  be mixed with a VAD-spawned chit-chat reply. */
export const ESCALATION_TURN_DETECTION: Record<string, unknown> = {
    ...DEFAULT_TURN_DETECTION,
    create_response: false,
    interrupt_response: false,
};

export class OpenAIRealtimeProvider extends VoiceProvider {
    #ws: WebSocket | null = null;
    readonly #apiKey: string;
    readonly #model: string;
    readonly #config: VoiceProviderConfig;
    readonly #logger: SessionLogger | null;
    readonly inputSampleRate = 24000;
    /**
     * call_id → function name lookup, populated from `response.output_item.added`
     * because the Realtime API does NOT include `name` in
     * `response.function_call_arguments.done` for some models.
     */
    readonly #pendingCalls = new Map<string, string>();
    /**
     * call_ids we have already emitted a functionCall for, to dedupe across
     * the three possible API event paths
     * (output_item.added with inline arguments / function_call_arguments.done /
     * output_item.done).
     */
    readonly #emittedCalls = new Set<string>();

    constructor(
        apiKey: string,
        model: string,
        config: VoiceProviderConfig,
        logger: SessionLogger | null = null,
    ) {
        super();
        this.#apiKey = apiKey;
        this.#model = model;
        this.#config = config;
        this.#logger = logger;
    }

    /** Build the `audio.input.transcription` object for the initial
     *  session.update. Defaults to gpt-4o-transcribe / ja which is the
     *  combo that gave us reliable Japanese transcripts. `language: ""` is
     *  treated as "auto-detect" and omitted from the payload. */
    #buildTranscriptionConfig = (): Record<string, unknown> => {
        const model = this.#config.transcriptionModel ?? "gpt-4o-transcribe";
        const cfg: Record<string, unknown> = { model };
        const lang = this.#config.transcriptionLanguage;
        if (lang && lang.length > 0) cfg.language = lang;
        return cfg;
    };

    /** Build the `audio.input.noise_reduction` value. OpenAI accepts
     *  `{ type: "near_field" | "far_field" }` or `null` (disabled, the
     *  default). Anything other than the two known types disables it. */
    #buildNoiseReduction = (): { type: string } | null => {
        const v = (this.#config.noiseReduction ?? "").trim();
        return v === "near_field" || v === "far_field" ? { type: v } : null;
    };

    /** `input_audio_buffer.append` fires every ~20 ms with a base64 audio
     *  chunk; it would flood the log with no diagnostic value. Drop it. */
    #shouldLog = (type: string | undefined): boolean => {
        if (!type) return true;
        if (type === "input_audio_buffer.append") return false;
        return true;
    };

    /** Replace bulky base64 audio deltas with size metadata so the log stays
     *  human-readable. */
    #summarise = (event: Record<string, unknown>): unknown => {
        const t = event.type as string | undefined;
        if (t === "response.output_audio.delta" || t === "response.audio.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            return { type: t, delta_b64_len: delta.length };
        }
        return event;
    };

    connect = (): Promise<void> => {
        return new Promise((resolve, reject) => {
            const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.#model)}`;
            // Plain Authorization is enough for the GA endpoint — the old
            // `OpenAI-Beta: realtime=v1` header now triggers the
            // `beta_api_shape_disabled` server error.
            const ws = new WebSocket(url, {
                headers: { Authorization: `Bearer ${this.#apiKey}` },
            });
            this.#ws = ws;

            ws.on("open", () => {
                this.send({
                    type: "session.update",
                    session: {
                        type: "realtime",
                        instructions: this.#config.instructions,
                        output_modalities: ["audio"],
                        audio: {
                            input: {
                                format: { type: "audio/pcm", rate: 24000 },
                                transcription: this.#buildTranscriptionConfig(),
                                noise_reduction: this.#buildNoiseReduction(),
                                turn_detection: DEFAULT_TURN_DETECTION,
                            },
                            output: {
                                format: { type: "audio/pcm", rate: 24000 },
                                voice: this.#config.voice ?? "marin",
                            },
                        },
                        tools: this.#config.tools,
                        tool_choice: this.#config.toolChoice ?? "auto",
                    },
                });
                this.emit("open");
                resolve();
            });

            ws.on("message", (data) => this.#handleMessage(data.toString("utf8")));
            ws.on("error", (err) => {
                this.emit("error", err);
                reject(err);
            });
            ws.on("close", (code, reason) => {
                this.emit("close", code, reason.toString("utf8"));
            });
        });
    };

    close = (): void => {
        if (this.#ws) {
            try {
                this.#ws.close();
            } catch {
                /* ignore */
            }
            this.#ws = null;
        }
    };

    /** Append a chunk of mic-captured PCM16 24 kHz mono audio. */
    appendAudio = (chunk: Buffer): void => {
        this.send({
            type: "input_audio_buffer.append",
            audio: chunk.toString("base64"),
        });
    };

    /** Provide the result of a function call back to the model. */
    sendFunctionCallOutput = (callId: string, output: string): void => {
        this.send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output },
        });
    };

    /** Update session tools / tool_choice / instructions dynamically. */
    updateSession = (patch: {
        tools?: RealtimeTool[];
        toolChoice?: ToolChoice;
        instructions?: string;
        turnDetection?: Record<string, unknown> | null;
    }): void => {
        // GA requires `session.type` on every session.update, not just the
        // initial one.
        const session: Record<string, unknown> = { type: "realtime" };
        if (patch.tools !== undefined) session.tools = patch.tools;
        if (patch.toolChoice !== undefined) session.tool_choice = patch.toolChoice;
        if (patch.instructions !== undefined) session.instructions = patch.instructions;
        if (patch.turnDetection !== undefined) {
            session.audio = { input: { turn_detection: patch.turnDetection } };
        }
        this.send({ type: "session.update", session });
    };

    /** Request the model to generate a response.
     *
     *  If `input` is provided, the response is generated against that input
     *  list **instead of** the live conversation history. This is the
     *  reliable way to override what the model sees in a `response.create`
     *  — `instructions` alone is advisory and can be ignored when the
     *  conversation has strong contextual momentum (e.g. mid-sentence on a
     *  prior topic). */
    createResponse = (
        opts: {
            instructions?: string;
            toolChoice?: ToolChoice;
            input?: Array<Record<string, unknown>>;
            conversation?: string;
        } = {},
    ): void => {
        const response: Record<string, unknown> = { output_modalities: ["audio"] };
        if (opts.instructions) response.instructions = opts.instructions;
        if (opts.toolChoice) response.tool_choice = opts.toolChoice;
        if (opts.input) response.input = opts.input;
        if (opts.conversation) response.conversation = opts.conversation;
        this.send({ type: "response.create", response });
    };

    /** Cancel the in-flight response (model interruption). */
    cancelResponse = (): void => {
        this.send({ type: "response.cancel" });
    };

    /** Truncate an assistant message item to the duration the user actually
     *  heard. Without this, a cancelled response leaves its partial text in
     *  the conversation history and the next response tends to pick up
     *  exactly where the model left off — which sounds like the agent
     *  "resumed" after a barge-in. */
    truncateItem = (itemId: string, audioEndMs: number, contentIndex = 0): void => {
        this.send({
            type: "conversation.item.truncate",
            item_id: itemId,
            content_index: contentIndex,
            audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
        });
    };

    /** Inject an assistant text item (no model trigger). */
    injectAssistantText = (text: string): void => {
        this.send({
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text }],
            },
        });
    };

    /** Inspect a function_call item from any of the three API event paths. */
    #maybeEmitFunctionCall = (item: unknown): void => {
        if (!item || typeof item !== "object") return;
        const it = item as {
            type?: string;
            name?: string;
            call_id?: string;
            arguments?: string;
        };
        if (it.type !== "function_call" || !it.call_id) return;
        if (it.name) this.#pendingCalls.set(it.call_id, it.name);
        const name = it.name ?? this.#pendingCalls.get(it.call_id);
        if (name && typeof it.arguments === "string" && it.arguments.length > 0) {
            this.#emitFunctionCall(it.call_id, name, it.arguments);
        }
    };

    #emitFunctionCall = (callId: string, name: string, args: string): void => {
        if (this.#emittedCalls.has(callId)) return;
        this.#emittedCalls.add(callId);
        this.#pendingCalls.delete(callId);
        this.emit("functionCall", { name, callId, arguments: args });
    };

    #numberField = (obj: Record<string, unknown>, key: string): number => {
        const value = obj[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };

    #extractUsage = (response: Record<string, unknown>): UsagePayload | null => {
        const usage = response.usage;
        if (!usage || typeof usage !== "object") return null;
        const u = usage as Record<string, unknown>;
        const inputDetails =
            u.input_token_details && typeof u.input_token_details === "object"
                ? (u.input_token_details as Record<string, unknown>)
                : {};
        const outputDetails =
            u.output_token_details && typeof u.output_token_details === "object"
                ? (u.output_token_details as Record<string, unknown>)
                : {};
        const cachedDetails =
            inputDetails.cached_tokens_details &&
            typeof inputDetails.cached_tokens_details === "object"
                ? (inputDetails.cached_tokens_details as Record<string, unknown>)
                : {};

        return {
            totalTokens: this.#numberField(u, "total_tokens"),
            inputTokens: this.#numberField(u, "input_tokens"),
            outputTokens: this.#numberField(u, "output_tokens"),
            inputTextTokens: this.#numberField(inputDetails, "text_tokens"),
            inputAudioTokens: this.#numberField(inputDetails, "audio_tokens"),
            inputCachedTokens: this.#numberField(inputDetails, "cached_tokens"),
            inputCachedTextTokens: this.#numberField(cachedDetails, "text_tokens"),
            inputCachedAudioTokens: this.#numberField(cachedDetails, "audio_tokens"),
            outputTextTokens: this.#numberField(outputDetails, "text_tokens"),
            outputAudioTokens: this.#numberField(outputDetails, "audio_tokens"),
            outputReasoningTokens: this.#numberField(outputDetails, "reasoning_tokens"),
        };
    };

    send = (event: Record<string, unknown>): void => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
            process.stderr.write(`[realtime] dropping send: not open (${this.#ws?.readyState})\n`);
            this.#logger?.log("rt.out", "drop", { type: event.type, reason: "ws-not-open" });
            return;
        }
        const t = event.type as string | undefined;
        if (this.#shouldLog(t)) {
            this.#logger?.log("rt.out", t ?? "unknown", this.#summarise(event));
        }
        this.#ws.send(JSON.stringify(event));
    };

    #handleMessage = (payload: string): void => {
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(payload);
        } catch (err) {
            this.emit("error", new Error(`bad JSON from realtime API: ${String(err)}`));
            return;
        }
        const inType = event.type as string | undefined;
        if (this.#shouldLog(inType)) {
            this.#logger?.log("rt.in", inType ?? "unknown", this.#summarise(event));
        }
        this.emit("raw", event);
        const type = event.type as string | undefined;
        switch (type) {
            case "response.output_audio.delta":
            case "response.audio.delta": {
                const b64 = event.delta;
                if (typeof b64 === "string") {
                    this.emit("audio", Buffer.from(b64, "base64"));
                }
                return;
            }
            case "response.output_audio_transcript.delta":
            case "response.audio_transcript.delta": {
                const delta = event.delta;
                if (typeof delta === "string") this.emit("transcript", delta, "assistant");
                return;
            }
            case "conversation.item.input_audio_transcription.completed": {
                const transcript = event.transcript;
                if (typeof transcript === "string") {
                    this.emit("transcript", transcript + "\n", "user");
                }
                return;
            }
            case "response.done": {
                const resp = (event.response ?? {}) as Record<string, unknown>;
                const output = (resp as { output?: unknown[] }).output;
                if (Array.isArray(output)) {
                    for (const item of output) this.#maybeEmitFunctionCall(item);
                }
                const usage = this.#extractUsage(resp);
                if (usage) this.emit("usage", usage);
                this.emit("responseDone", resp);
                return;
            }
            case "response.output_item.added":
            case "response.output_item.done":
                this.#maybeEmitFunctionCall(event.item);
                return;
            case "response.function_call_arguments.done": {
                const callId = event.call_id;
                const args = event.arguments;
                const directName = typeof event.name === "string" ? event.name : undefined;
                if (typeof callId === "string" && typeof args === "string") {
                    const name = directName ?? this.#pendingCalls.get(callId);
                    if (name) this.#emitFunctionCall(callId, name, args);
                }
                return;
            }
            case "error": {
                const err = event.error as { message?: string; code?: string } | undefined;
                this.emit(
                    "error",
                    new Error(`realtime error: ${err?.code ?? "?"} ${err?.message ?? ""}`),
                );
                return;
            }
            default:
                return;
        }
    };
}
