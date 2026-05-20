/**
 * `classifyApproval` / `summarize` behaviour for Phase 2 — checks that the
 * audio LLM gets a decisively-shaped, sanitised summary (verb + basename), not
 * the raw command. Verdict logic itself is exercised indirectly by the
 * existing session integration tests; here we focus on the summary string the
 * Realtime model sees.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyApproval, type PolicyInput } from "../src/approval-policy.js";
import { getVoiceStrings } from "../src/i18n/voice-strings.js";

const jaStrings = getVoiceStrings("ja");
const enStrings = getVoiceStrings("en");

const baseInput = (overrides: Partial<PolicyInput>): PolicyInput => ({
    kind: "commandExecution",
    method: "execCommand",
    params: {},
    cwd: "/ws",
    ...overrides,
});

test("commandExecution: summary embeds verb + basenamed args (ja)", () => {
    // `rm` matches CRITICAL_PATTERNS only when the haystack contains "rm "
    // (string form). Whether we land on escalate / auto-accept doesn't matter
    // for this test — we only care about the .summary string shape.
    const { summary } = classifyApproval(
        baseInput({ params: { command: "rm README.md", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(summary, "rm README.md の承認依頼です。");
});

test("commandExecution: summary embeds verb + basenamed args (en)", () => {
    const { summary } = classifyApproval(
        baseInput({ params: { command: "rm README.md", cwd: "/ws" } }),
        enStrings,
    );
    assert.equal(summary, "Codex is asking to run: rm README.md.");
});

test("commandExecution: array params basename path-like args", () => {
    const { summary } = classifyApproval(
        baseInput({ params: { command: ["rm", "-rf", "/tmp/foo"], cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(summary, "rm -rf foo の承認依頼です。");
});

test("commandExecution: env-like values are redacted in the audio summary", () => {
    const { summary } = classifyApproval(
        baseInput({ params: { command: "FOO_TOKEN=abc rm x", cwd: "/ws" } }),
        jaStrings,
    );
    assert.ok(summary.includes("FOO_TOKEN=<redacted>"), summary);
    assert.ok(!summary.includes("FOO_TOKEN=abc"), summary);
});

test("commandExecution: summary is capped to 200 chars", () => {
    // Pad with enough whitespace-separated tokens to exceed 200 chars even
    // after sentinel truncation. extractCommandTokens already trims to 5
    // entries, so the cap mostly defends against pathological en/ja templates.
    const longArg = "x".repeat(300);
    const { summary } = classifyApproval(
        baseInput({ params: { command: `cmd ${longArg}`, cwd: "/ws" } }),
        jaStrings,
    );
    assert.ok(summary.length <= 200, `summary length: ${summary.length}`);
});

test("commandExecution: empty / missing command yields a speakable fallback", () => {
    const { summary } = classifyApproval(baseInput({ params: { cwd: "/ws" } }), jaStrings);
    assert.equal(summary, "コマンド実行の承認依頼です。");
});

test("humanReadable: summary uses the fallback template with the redacted body", () => {
    const { summary } = classifyApproval(
        baseInput({
            kind: "toolUserInput",
            params: { humanReadable: "Need confirmation for FOO_TOKEN=abc op" },
        }),
        jaStrings,
    );
    assert.ok(summary.startsWith("Codex が承認を求めています"), summary);
    assert.ok(summary.includes("<redacted>"), summary);
});

test("fileChange: summary lists basenames for the modify path", () => {
    const { summary } = classifyApproval(
        baseInput({
            kind: "fileChange",
            params: {},
            resolvedPaths: ["/ws/src/a.ts", "/ws/src/b.ts"],
            hasDelete: false,
        }),
        jaStrings,
    );
    assert.equal(summary, "ファイル変更の承認依頼です。対象: a.ts, b.ts");
});

test("fileChange: delete path uses the dedicated template", () => {
    const { summary } = classifyApproval(
        baseInput({
            kind: "fileChange",
            params: {},
            resolvedPaths: ["/ws/x.ts"],
            hasDelete: true,
        }),
        jaStrings,
    );
    assert.equal(summary, "ファイル削除の承認依頼です。対象: x.ts");
});

test("fileChange: no resolved paths and no reason yields the bare fallback", () => {
    const { summary } = classifyApproval(baseInput({ kind: "fileChange", params: {} }), jaStrings);
    assert.equal(summary, "Codex が承認を求めています。");
});

test("unknown kind: summary uses the unknownKind template", () => {
    const { summary } = classifyApproval(
        baseInput({ kind: "weirdKind" as PolicyInput["kind"], params: {} }),
        jaStrings,
    );
    assert.equal(summary, "weirdKind 承認リクエスト");
});

test("auto language: summary mirrors en (autoStrings inherits en summarize)", () => {
    const autoStrings = getVoiceStrings("auto");
    const cases = [
        { command: "rm README.md", cwd: "/ws" },
        { command: ["rm", "-rf", "/tmp/x"], cwd: "/ws" },
    ];
    for (const params of cases) {
        const fromAuto = classifyApproval(baseInput({ params }), autoStrings).summary;
        const fromEn = classifyApproval(baseInput({ params }), enStrings).summary;
        assert.equal(fromAuto, fromEn);
    }
});

test("defensive: null params do not throw and yield the empty-token fallback", () => {
    const { summary } = classifyApproval(baseInput({ params: null }), jaStrings);
    assert.equal(summary, "コマンド実行の承認依頼です。");
});
