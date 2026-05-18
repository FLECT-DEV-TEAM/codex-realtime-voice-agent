import {
    GoogleGenAI,
    Modality,
    type LiveConnectConfig,
    type LiveServerMessage,
    type Session,
} from "@google/genai";
import type { SessionLogger } from "../session-logger.js";
import {
    VoiceProvider,
    type RealtimeTool,
    type ToolChoice,
    type UsagePayload,
    type VoiceProviderConfig,
} from "./voice-provider.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview";

export class GeminiLiveProvider extends VoiceProvider {
    readonly inputSampleRate = 16000;
    #ai: GoogleGenAI;
    #session: Session | null = null;
    readonly #model: string;
    readonly #config: VoiceProviderConfig;
    readonly #logger: SessionLogger | null;
    readonly #thinkingLevel: string | undefined;
    /** call_id -> function name lookup, kept consistent with OpenAI's behavior. */
    readonly #pendingCalls = new Map<string, string>();
    /** Tracks responses we have already emitted to dedupe. */
    readonly #emittedCalls = new Set<string>();

    constructor(
        apiKey: string,
        model: string,
        config: VoiceProviderConfig & { thinkingLevel?: string },
        logger: SessionLogger | null = null,
    ) {
        super();
        this.#ai = new GoogleGenAI({ apiKey });
        this.#model = model || DEFAULT_GEMINI_MODEL;
        this.#config = config;
        this.#thinkingLevel = config.thinkingLevel;
        this.#logger = logger;
    }

    connect = async (): Promise<void> => {
        const liveConfig: Record<string, unknown> = {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: this.#config.voice || "Kore" },
                },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: this.#config.instructions,
        };
        if (this.#config.tools.length > 0) {
            liveConfig.tools = [
                {
                    functionDeclarations: this.#config.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parametersJsonSchema: t.parameters,
                    })),
                },
            ];
        }
        if (this.#thinkingLevel) {
            liveConfig.thinkingConfig = { thinkingLevel: this.#thinkingLevel };
        }
        this.#session = await this.#ai.live.connect({
            model: this.#model,
            config: liveConfig as LiveConnectConfig,
            callbacks: {
                onopen: () => {
                    this.#logger?.log("gemini.in", "open");
                    this.emit("open");
                },
                onmessage: (message: LiveServerMessage) => this.#handleMessage(message),
                onerror: (err: ErrorEvent) => {
                    const message = err.message || "Gemini Live error";
                    this.#logger?.log("gemini.in", "error", { message });
                    this.emit("error", new Error(message));
                },
                onclose: (ev: CloseEvent) => {
                    this.#logger?.log("gemini.in", "close", {
                        code: ev.code,
                        reason: ev.reason,
                    });
                    this.emit("close", ev.code, ev.reason);
                },
            },
        });
    };

    #handleMessage = (msg: LiveServerMessage): void => {
        const m = msg as unknown as Record<string, unknown>;
        this.#logger?.log("gemini.in", "message", this.#summarise(m));
        this.emit("raw", m);
        const sc = msg.serverContent;
        if (sc) {
            const parts = sc.modelTurn?.parts;
            if (parts) {
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        this.emit("audio", Buffer.from(part.inlineData.data, "base64"));
                    }
                }
            }
            if (sc.inputTranscription?.text) {
                this.emit("transcript", sc.inputTranscription.text, "user");
            }
            if (sc.outputTranscription?.text) {
                this.emit("transcript", sc.outputTranscription.text, "assistant");
            }
            if (sc.turnComplete) {
                this.emit("responseDone", { interrupted: sc.interrupted === true });
            }
            if (sc.interrupted) {
                this.#logger?.log("gemini.in", "interrupted");
            }
        }
        const functionCalls = msg.toolCall?.functionCalls;
        if (functionCalls) {
            for (const fc of functionCalls) {
                if (!fc.id || !fc.name) continue;
                if (this.#emittedCalls.has(fc.id)) continue;
                this.#emittedCalls.add(fc.id);
                this.#pendingCalls.set(fc.id, fc.name);
                this.emit("functionCall", {
                    callId: fc.id,
                    name: fc.name,
                    arguments: JSON.stringify(fc.args ?? {}),
                });
            }
        }
        const usageMeta = msg.usageMetadata;
        if (usageMeta) {
            const inputDetails = usageMeta.promptTokensDetails ?? [];
            const outputDetails = usageMeta.responseTokensDetails ?? [];
            const findToken = (
                details: Array<{ modality?: string; tokenCount?: number }>,
                modality: string,
            ): number =>
                details.find((d) => String(d.modality ?? "").toUpperCase() === modality)
                    ?.tokenCount ?? 0;
            const payload: UsagePayload = {
                totalTokens: usageMeta.totalTokenCount ?? 0,
                inputTokens: usageMeta.promptTokenCount ?? 0,
                outputTokens: usageMeta.responseTokenCount ?? 0,
                inputTextTokens: findToken(inputDetails, "TEXT"),
                inputAudioTokens: findToken(inputDetails, "AUDIO"),
                inputCachedTokens: 0,
                inputCachedTextTokens: 0,
                inputCachedAudioTokens: 0,
                outputTextTokens: findToken(outputDetails, "TEXT"),
                outputAudioTokens: findToken(outputDetails, "AUDIO"),
                outputReasoningTokens: 0,
            };
            this.emit("usage", payload);
        }
    };

    close = (): void => {
        try {
            this.#session?.close();
        } catch {
            /* ignore */
        }
        this.#session = null;
    };

    appendAudio = (chunk: Buffer): void => {
        if (!this.#session) return;
        const data = chunk.toString("base64");
        this.#session.sendRealtimeInput({
            audio: { data, mimeType: "audio/pcm;rate=16000" },
        });
        this.#logger?.log("gemini.out", "audio", { audio_b64_len: data.length });
    };

    sendFunctionCallOutput = (callId: string, output: string): void => {
        if (!this.#session) return;
        const name = this.#pendingCalls.get(callId) ?? "";
        let response: Record<string, unknown>;
        try {
            const parsed = JSON.parse(output) as unknown;
            response =
                parsed && typeof parsed === "object"
                    ? (parsed as Record<string, unknown>)
                    : { result: parsed };
        } catch {
            response = { result: output };
        }
        this.#session.sendToolResponse({
            functionResponses: [{ id: callId, name, response }],
        });
        this.#logger?.log("gemini.out", "toolResponse", { callId, name });
        this.#pendingCalls.delete(callId);
    };

    createResponse = (opts: { input?: Array<Record<string, unknown>> } = {}): void => {
        if (!opts.input || !this.#session) return;
        const turns = opts.input.map((item: Record<string, unknown>) => {
            const content = item.content as Array<{ text?: string }> | undefined;
            const parts = (content ?? [])
                .map((c) => (typeof c.text === "string" ? { text: c.text } : null))
                .filter((p): p is { text: string } => p !== null);
            return { role: (item.role as string) ?? "user", parts };
        });
        this.#session.sendClientContent({ turns, turnComplete: true });
        this.#logger?.log("gemini.out", "clientContent", { turns: turns.length });
    };

    cancelResponse = (): void => {
        // Gemini Live handles VAD interruption server-side.
    };

    truncateItem = (_itemId: string, _audioEndMs: number, _contentIndex = 0): void => {
        // Gemini Live auto-truncates interrupted turns.
    };

    updateSession = (_patch: {
        tools?: RealtimeTool[];
        toolChoice?: ToolChoice;
        instructions?: string;
        turnDetection?: Record<string, unknown> | null;
    }): void => {
        this.#logger?.log("gemini.out", "updateSession-noop", {
            fields: Object.keys(_patch),
        });
    };

    injectAssistantText = (_text: string): void => {
        this.#logger?.log("gemini.out", "injectAssistantText-noop");
    };

    send = (event: Record<string, unknown>): void => {
        this.#logger?.log("gemini.out", "raw-send-noop", { keys: Object.keys(event) });
    };

    #summarise = (m: Record<string, unknown>): unknown => {
        if (m.serverContent && typeof m.serverContent === "object") {
            const sc = m.serverContent as { modelTurn?: { parts?: unknown[] } };
            if (sc.modelTurn?.parts) {
                return {
                    serverContent: {
                        modelTurnParts: sc.modelTurn.parts.length,
                    },
                };
            }
        }
        return m;
    };
}
