import { EventEmitter } from "node:events";

export interface RealtimeTool {
    type: "function";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

export interface VoiceProviderConfig {
    instructions: string;
    voice?: string;
    tools: RealtimeTool[];
    toolChoice?: ToolChoice;
    transcriptionModel?: string;
    transcriptionLanguage?: string;
    /** Input-audio noise reduction: "near_field" | "far_field" | "off"
     *  (or empty). OpenAI provider only. */
    noiseReduction?: string;
}

export type UsagePayload = {
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

export interface VoiceProviderEvents {
    open: () => void;
    close: (code: number, reason: string) => void;
    error: (err: Error) => void;
    audio: (chunk: Buffer) => void;
    transcript: (text: string, role: "assistant" | "user") => void;
    functionCall: (call: { name: string; callId: string; arguments: string }) => void;
    responseDone: (response: Record<string, unknown>) => void;
    usage: (payload: UsagePayload) => void;
    raw: (event: Record<string, unknown>) => void;
}

export declare interface VoiceProvider {
    on<E extends keyof VoiceProviderEvents>(event: E, listener: VoiceProviderEvents[E]): this;
    emit<E extends keyof VoiceProviderEvents>(
        event: E,
        ...args: Parameters<VoiceProviderEvents[E]>
    ): boolean;
    off<E extends keyof VoiceProviderEvents>(event: E, listener: VoiceProviderEvents[E]): this;
}

export abstract class VoiceProvider extends EventEmitter {
    /** Open the underlying connection (WebSocket etc.). */
    abstract connect(): Promise<void>;
    /** Close the connection. */
    abstract close(): void;
    /** Stream a chunk of mic-captured PCM16 mono audio. Sample rate depends on the provider's input rate (24kHz for OpenAI, 16kHz for Gemini). */
    abstract appendAudio(chunk: Buffer): void;
    /** Provide the result of a function call back to the model. */
    abstract sendFunctionCallOutput(callId: string, output: string): void;
    /** Request the model to generate a response. */
    abstract createResponse(opts?: {
        instructions?: string;
        toolChoice?: ToolChoice;
        input?: Array<Record<string, unknown>>;
        conversation?: string;
    }): void;
    /** Cancel the in-flight response. */
    abstract cancelResponse(): void;
    /** Truncate an assistant message item (OpenAI-specific; no-op on providers that auto-truncate). */
    abstract truncateItem(itemId: string, audioEndMs: number, contentIndex?: number): void;
    /** Update session-level configuration (tools, toolChoice, instructions, turnDetection). */
    abstract updateSession(patch: {
        tools?: RealtimeTool[];
        toolChoice?: ToolChoice;
        instructions?: string;
        turnDetection?: Record<string, unknown> | null;
    }): void;
    /** Inject an assistant text item without triggering a response. */
    abstract injectAssistantText(text: string): void;
    /** Raw escape hatch - send a provider-native event. May be a no-op on some providers. */
    abstract send(event: Record<string, unknown>): void;
    /** What audio sample rate the provider expects (Hz). */
    abstract readonly inputSampleRate: number;
}
