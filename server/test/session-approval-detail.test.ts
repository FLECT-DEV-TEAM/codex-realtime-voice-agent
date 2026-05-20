/**
 * Wire-level integration test for `approval/notice.detail`.
 *
 * Drives a Session end-to-end with a fake WebSocket and a fake voice provider,
 * fires an `approval-requested` of kind `commandExecution`, and asserts that
 * the next `approval/notice` message published on the WS carries the sanitised
 * display detail (kind / command / cwd lines) — proving the
 * `buildApprovalDisplayDetail` ↔ `#emitApprovalNotice` ↔ wire path is wired
 * end-to-end. Sanitisation correctness itself lives in the dedicated unit
 * tests (`approval-sanitize.test.ts`, `approval-display-detail.test.ts`).
 */
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

const findApprovalNotice = (
    sent: string[],
): { summary: string; kind: string; detail?: string } | undefined => {
    for (const raw of sent) {
        try {
            const msg = JSON.parse(raw) as { type?: string } & Record<string, unknown>;
            if (msg.type === "approval/notice") {
                return msg as { summary: string; kind: string; detail?: string };
            }
        } catch {
            // ignore non-JSON frames
        }
    }
    return undefined;
};

test("approval/notice carries sanitised displayDetail for commandExecution", async () => {
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
            codexCwd: "/ws",
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
                settings: { transcriptionLanguage: "ja" },
            }),
        ),
        false,
    );
    await tick();
    await tick();
    assert.ok(provider, "voice provider was not created");

    // Fire a commandExecution approval. We use a command that the policy's
    // CRITICAL_PATTERNS will escalate (string form, since the JSON-stringified
    // haystack uses `\s` boundaries that the array-of-tokens form doesn't
    // satisfy). `git push` is one of the patterns guaranteed to escalate.
    const approval = approvalRequested?.({
        kind: "commandExecution",
        method: "execCommand",
        params: {
            command: "git push origin main",
            cwd: "/ws/server/workspace",
        },
    });
    assert.ok(approval, "approvalRequested handler was not registered");

    // Resolve the escalation immediately by feeding a clear-yes transcript;
    // the wire-level approval/notice is emitted synchronously before voice
    // playback begins, so we don't need to wait for the spoken phases.
    await tick();
    provider!.emit("transcript", "はい", "user");
    await approval;
    await tick();

    const notice = findApprovalNotice(ws.sent);
    if (!notice) {
        const seen = ws.sent
            .map((raw) => {
                try {
                    return (JSON.parse(raw) as { type?: string }).type ?? "?";
                } catch {
                    return "(non-json)";
                }
            })
            .join(", ");
        assert.fail(`no approval/notice was sent over the wire. observed types: [${seen}]`);
    }
    assert.equal(notice.kind, "commandExecution");
    assert.ok(notice.detail, "detail field is missing");

    const detail = notice.detail!;
    // Kind line is always present.
    assert.ok(detail.startsWith("種別: commandExecution"), `kind line missing: ${detail}`);
    // Command line uses sanitised displayCommand (string form passes through redact/escape).
    assert.ok(detail.includes("コマンド: git push origin main"), `command line missing: ${detail}`);
    // cwd is workspace-relative (workspace="/ws", cwd="/ws/server/workspace").
    assert.ok(
        detail.includes("作業ディレクトリ: server/workspace"),
        `cwd should be relative: ${detail}`,
    );

    turnGate.release();
    await tick();
    await session.stop();
});

test("approval/notice for permissions kind emits detail with kind-only body", async () => {
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
            codexCwd: "/ws",
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
            JSON.stringify({ type: "session/start", settings: { transcriptionLanguage: "ja" } }),
        ),
        false,
    );
    await tick();
    await tick();
    assert.ok(provider);

    const approval = approvalRequested?.({
        kind: "permissions",
        method: "test",
        params: { reason: "needs-confirmation", token: "secret-token-xyz" },
    });
    assert.ok(approval);
    await tick();
    provider!.emit("transcript", "実行してほしくない", "user");
    await approval;
    await tick();

    const notice = findApprovalNotice(ws.sent);
    assert.ok(notice);
    assert.equal(notice.kind, "permissions");
    // Whitelist enforcement: only kind line, no raw params leak.
    assert.equal(notice.detail, "種別: permissions");
    assert.ok(!notice.detail.includes("secret-token-xyz"));

    turnGate.release();
    await tick();
    await session.stop();
});
