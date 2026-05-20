import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket as WS } from "ws";
import { Session } from "../src/session.js";
import { VoiceProvider } from "../src/providers/voice-provider.js";

type ResponseOptions = Parameters<VoiceProvider["createResponse"]>[0];
type UpdateSessionPatch = Parameters<VoiceProvider["updateSession"]>[0];
type ApprovalRequest = {
    kind: string;
    method: string;
    params: unknown;
};
type ApprovalDecision = { decision: "accept" | "refuse" };
type LogEntry = {
    src?: unknown;
    ev?: unknown;
    data?: unknown;
};
type ApprovalLogData = {
    text: string;
    kind: "accept" | "refuse" | "question" | "ambiguous";
    lang: string;
    transcriptionLanguage: string;
    textLength: number;
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
    readonly inputSampleRate = 24_000;

    connect = async (): Promise<void> => undefined;
    close = (): void => undefined;
    appendAudio = (_chunk: Buffer): void => undefined;
    sendFunctionCallOutput = (_callId: string, _output: string): void => undefined;
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

const awaitLogFlush = async (
    file: string,
    predicate: (lines: object[]) => boolean,
    timeoutMs = 2000,
): Promise<object[]> => {
    const startedAt = Date.now();
    let lastLines: object[] = [];
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const raw = await readFile(file, "utf8");
            lastLines = raw
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as object);
            if (predicate(lastLines)) return lastLines;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Timed out waiting for log flush in ${file}; lines=${lastLines.length}`);
};

const isApprovalEntry = (entry: object): entry is LogEntry & { data: ApprovalLogData } => {
    const candidate = entry as LogEntry;
    if (candidate.src !== "voice" || candidate.ev !== "approval-utterance") return false;
    if (!candidate.data || typeof candidate.data !== "object") return false;
    const data = candidate.data as Record<string, unknown>;
    return (
        typeof data.text === "string" &&
        (data.kind === "accept" ||
            data.kind === "refuse" ||
            data.kind === "question" ||
            data.kind === "ambiguous") &&
        typeof data.lang === "string" &&
        typeof data.transcriptionLanguage === "string" &&
        typeof data.textLength === "number"
    );
};

const startSession = async (
    transcriptionLanguage: string,
): Promise<{
    session: Session;
    ws: FakeWs;
    provider: FakeProvider;
    logFile: string;
    requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}> => {
    let approvalRequested: ((request: ApprovalRequest) => Promise<ApprovalDecision>) | null = null;
    let provider: FakeProvider | null = null;
    const logsDir = mkdtempSync(path.join(os.tmpdir(), "decision-metrics-"));
    const turnGate = createTurnGate();
    const ws = new FakeWs();
    const session = new Session(
        {
            apiKey: "test-openai-key",
            defaultModel: "gpt-realtime-2",
            defaultVoice: "marin",
            defaultGeminiModel: "gemini-live-2.5-flash-preview",
            codexCwd: process.cwd(),
            logsDir,
            createBridge: (config) => {
                approvalRequested = (
                    config as unknown as {
                        onApprovalRequested: (
                            request: ApprovalRequest,
                        ) => Promise<ApprovalDecision>;
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
            createRealtimeProvider: () => {
                provider = new FakeProvider();
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
                settings: { transcriptionLanguage },
            }),
        ),
        false,
    );
    await tick();
    await tick();

    assert.ok(provider);
    assert.ok(approvalRequested);
    return {
        session,
        ws,
        provider,
        logFile: path.join(logsDir, "latest.jsonl"),
        requestApproval: approvalRequested,
    };
};

const requestEscalation = (
    requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>,
): Promise<ApprovalDecision> =>
    requestApproval({
        kind: "permissions",
        method: "test",
        params: { reason: "needs confirmation" },
    });

const assertApprovalLog = (lines: object[], expected: ApprovalLogData): ApprovalLogData => {
    const entry = lines.find(isApprovalEntry);
    assert.ok(entry, "approval-utterance log entry should exist");
    assert.deepEqual(entry.data, expected);
    return entry.data;
};

const runVerdictLogCase = async (
    transcriptionLanguage: string,
    text: string,
    kind: ApprovalLogData["kind"],
): Promise<void> => {
    const { session, provider, logFile, requestApproval } =
        await startSession(transcriptionLanguage);
    const approval = requestEscalation(requestApproval);
    await tick();
    await tick();

    provider.emit("transcript", text, "user");
    await tick();
    await session.stop();
    await approval.catch(() => ({ decision: "refuse" as const }));

    const lines = await awaitLogFlush(logFile, (entries) =>
        entries.some((entry) => isApprovalEntry(entry) && entry.data.kind === kind),
    );
    assertApprovalLog(lines, {
        text,
        kind,
        lang: transcriptionLanguage === "en" ? "en" : "ja",
        transcriptionLanguage,
        textLength: text.length,
    });
};

test("approval-utterance metrics include snapshot language fields for accept verdict", async () => {
    await runVerdictLogCase("ja", "はい", "accept");
});

test("approval-utterance metrics include snapshot language fields for refuse verdict", async () => {
    await runVerdictLogCase("ja", "いいえ", "refuse");
});

test("approval-utterance metrics include snapshot language fields for question verdict", async () => {
    await runVerdictLogCase("ja", "これは何ですか?", "question");
});

test("approval-utterance metrics include snapshot language fields for ambiguous verdict", async () => {
    await runVerdictLogCase("en", "another", "ambiguous");
});

test("approval-utterance transcriptionLanguage remains start-time snapshot after settings/update", async () => {
    const { session, ws, provider, logFile, requestApproval } = await startSession("ja");
    const approval = requestEscalation(requestApproval);
    await tick();
    await tick();

    ws.emit(
        "message",
        Buffer.from(
            JSON.stringify({ type: "settings/update", settings: { transcriptionLanguage: "en" } }),
        ),
        false,
    );
    await tick();

    const text = "いいえ";
    provider.emit("transcript", text, "user");
    await tick();
    await session.stop();
    await approval;

    const lines = await awaitLogFlush(logFile, (entries) =>
        entries.some((entry) => isApprovalEntry(entry) && entry.data.kind === "refuse"),
    );
    assertApprovalLog(lines, {
        text,
        kind: "refuse",
        lang: "ja",
        transcriptionLanguage: "ja",
        textLength: text.length,
    });
});
