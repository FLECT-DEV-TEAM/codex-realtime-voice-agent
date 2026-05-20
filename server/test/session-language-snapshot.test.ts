import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket as WS } from "ws";
import { Session } from "../src/session.js";
import {
    VoiceProvider,
    type RealtimeTool,
    type ToolChoice,
} from "../src/providers/voice-provider.js";

type ResponseOptions = Parameters<VoiceProvider["createResponse"]>[0];
type UpdateSessionPatch = Parameters<VoiceProvider["updateSession"]>[0];
type ApprovalRequest = {
    kind: string;
    method: string;
    params: unknown;
};

class FakeWs extends EventEmitter {
    readonly sent: string[] = [];
    readyState = WS.OPEN;

    send(data: string | Buffer): void {
        this.sent.push(data.toString());
    }
}

class FakeProvider extends VoiceProvider {
    readonly responses: ResponseOptions[] = [];
    readonly updates: UpdateSessionPatch[] = [];
    readonly outputs: Array<{ callId: string; output: string }> = [];
    readonly inputSampleRate = 24_000;

    constructor(readonly initialInstructions: string) {
        super();
    }

    connect = async (): Promise<void> => undefined;
    close = (): void => undefined;
    appendAudio = (_chunk: Buffer): void => undefined;
    sendFunctionCallOutput = (callId: string, output: string): void => {
        this.outputs.push({ callId, output });
    };
    createResponse = (opts?: ResponseOptions): void => {
        this.responses.push(opts);
    };
    cancelResponse = (): void => undefined;
    truncateItem = (_itemId: string, _audioEndMs: number, _contentIndex?: number): void =>
        undefined;
    updateSession = (patch: UpdateSessionPatch): void => {
        this.updates.push(patch);
    };
    injectAssistantText = (_text: string): void => undefined;
    send = (_event: Record<string, unknown>): void => undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const responseText = (opts: ResponseOptions): string => {
    const input = opts?.input?.[0] as { content?: Array<{ text?: string }> } | undefined;
    return input?.content?.[0]?.text ?? "";
};

const createTurnGate = (): {
    release: () => void;
    startTurn: () => AsyncIterable<{ type: string; [key: string]: unknown }>;
} => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        release,
        startTurn: async function* (): AsyncIterable<{ type: string; [key: string]: unknown }> {
            yield { type: "turn-started", turn: { turn: { id: "turn-1" } } };
            await released;
            yield { type: "turn-completed" };
        },
    };
};

test("Session keeps activeConversationLanguage fixed after settings/update across seams", async () => {
    let approvalRequested:
        | ((request: ApprovalRequest) => Promise<{ decision: "accept" | "refuse" }>)
        | null = null;
    let provider: FakeProvider | null = null;
    const turnGate = createTurnGate();

    const ws = new FakeWs();
    const session = new Session(
        {
            apiKey: "test-openai-key",
            defaultModel: "gpt-realtime-2",
            defaultVoice: "marin",
            defaultGeminiModel: "gemini-live-2.5-flash-preview",
            codexCwd: process.cwd(),
            logsDir: "/tmp",
            createBridge: (config) => {
                approvalRequested = (
                    config as unknown as {
                        onApprovalRequested: (
                            request: ApprovalRequest,
                        ) => Promise<{ decision: "accept" | "refuse" }>;
                    }
                ).onApprovalRequested;
                return {
                    client: { onNotification: () => ({ dispose: () => undefined }) },
                    connect: async () => undefined,
                    startThread: async () => ({ thread: { id: "thread-1" } }),
                    startTurn: turnGate.startTurn,
                    close: async () => undefined,
                };
            },
            createRealtimeProvider: ({ instructions }) => {
                provider = new FakeProvider(instructions);
                return provider;
            },
        },
        ws as unknown as WS,
    );

    ws.emit(
        "message",
        Buffer.from(
            JSON.stringify({
                type: "session/start",
                settings: { transcriptionLanguage: "ja", instructionsExtra: "Reply in English." },
            }),
        ),
        false,
    );
    await tick();
    await tick();

    assert.equal(session.activeConversationLanguage, "ja");
    assert.ok(provider);
    assert.match(provider.initialInstructions, /自然な日本語/);
    assert.match(provider.initialInstructions, /Reply in English/);

    ws.emit(
        "message",
        Buffer.from(
            JSON.stringify({ type: "settings/update", settings: { transcriptionLanguage: "en" } }),
        ),
        false,
    );
    await tick();
    assert.equal(session.activeConversationLanguage, "ja");

    const approval = approvalRequested?.({
        kind: "permissions",
        method: "test",
        params: { reason: "needs confirmation" },
    });
    assert.ok(approval);
    await tick();
    assert.match(responseText(provider.responses[0]), /確認の依頼/);
    provider.emit("responseDone", {});
    await tick();
    assert.match(responseText(provider.responses[1]), /はい か いいえ/);

    provider.emit("transcript", "実行してほしくない", "user");
    assert.deepEqual(await approval, { decision: "refuse" });
    await tick();
    assert.match(responseText(provider.responses[2]), /却下しました/);

    provider.emit("functionCall", {
        name: "codex_turn",
        callId: "first",
        arguments: JSON.stringify({ message: "long running turn" }),
    });
    await tick();
    provider.emit("functionCall", {
        name: "codex_turn",
        callId: "second",
        arguments: JSON.stringify({ message: "second turn" }),
    });
    await tick();

    assert.equal(provider.outputs.length, 1);
    assert.equal(provider.outputs[0]?.callId, "second");
    assert.match(provider.outputs[0]?.output ?? "", /前のターンがまだ実行中です/);

    turnGate.release();
    await tick();
    await session.stop();
});
