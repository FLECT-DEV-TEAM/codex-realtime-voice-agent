import assert from "node:assert/strict";
import test from "node:test";
import { VoiceApprovalCoordinator } from "../src/voice-approval.js";
import {
    VoiceProvider,
    type RealtimeTool,
    type ToolChoice,
} from "../src/providers/voice-provider.js";
import { getVoiceStrings } from "../src/i18n/voice-strings.js";

type ResponseOptions = Parameters<VoiceProvider["createResponse"]>[0];

class FakeProvider extends VoiceProvider {
    readonly responses: ResponseOptions[] = [];
    readonly updates: Array<Record<string, unknown>> = [];
    readonly outputs: Array<{ callId: string; output: string }> = [];
    readonly inputSampleRate = 24_000;

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
    updateSession = (patch: {
        tools?: RealtimeTool[];
        toolChoice?: ToolChoice;
        instructions?: string;
        turnDetection?: Record<string, unknown> | null;
    }): void => {
        this.updates.push(patch);
    };
    injectAssistantText = (_text: string): void => undefined;
    send = (_event: Record<string, unknown>): void => undefined;
}

const responseText = (opts: ResponseOptions): string => {
    const input = opts?.input?.[0] as { content?: Array<{ text?: string }> } | undefined;
    return input?.content?.[0]?.text ?? "";
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("VoiceApprovalCoordinator uses conversation-language strings for every spoken step", async () => {
    const provider = new FakeProvider();
    const strings = getVoiceStrings("en");
    const coordinator = new VoiceApprovalCoordinator(
        provider,
        { onInterrupt: async () => undefined },
        strings,
    );

    const decision = coordinator.escalate("Codex is asking to modify Header.tsx", "Kind: file");
    await tick();
    assert.equal(provider.responses.length, 1);
    assert.match(provider.responses[0]?.instructions ?? "", /natural English/);
    assert.match(responseText(provider.responses[0]), /Codex needs your confirmation/);

    provider.emit("responseDone", {});
    await tick();
    assert.equal(provider.responses.length, 2);
    assert.match(provider.responses[1]?.instructions ?? "", /yes or no answer/);
    assert.match(responseText(provider.responses[1]), /May I let Codex proceed/);

    coordinator.clarify("Which file?");
    await tick();
    assert.equal(provider.responses.length, 3);
    assert.match(provider.responses[2]?.instructions ?? "", /Which file/);
    assert.match(responseText(provider.responses[2]), /User question/);

    coordinator.ambiguous();
    await tick();
    assert.equal(provider.responses.length, 4);
    assert.match(provider.responses[3]?.instructions ?? "", /please answer yes or no/i);
    assert.match(responseText(provider.responses[3]), /answer yes or no/);

    coordinator.accept();
    assert.equal(await decision, "accept");
    await tick();
    assert.equal(provider.responses.length, 5);
    assert.match(provider.responses[4]?.instructions ?? "", /short English sentence/);
    assert.match(responseText(provider.responses[4]), /Approved/);
});

test("VoiceApprovalCoordinator Gemini seam is protected by localized input text", async () => {
    const provider = new FakeProvider();
    const coordinator = new VoiceApprovalCoordinator(
        provider,
        { onInterrupt: async () => undefined },
        getVoiceStrings("ja"),
    );

    void coordinator.escalate("ファイル変更の承認依頼です");
    await tick();
    assert.match(responseText(provider.responses[0]), /確認の依頼/);
    provider.emit("responseDone", {});
    await tick();
    assert.match(responseText(provider.responses[1]), /はい か いいえ/);
});
