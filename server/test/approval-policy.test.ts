/**
 * `classifyApproval` / `summarize` behaviour for Phase 2 — checks that the
 * audio LLM gets a decisively-shaped, sanitised summary (verb + basename), not
 * the raw command. Verdict logic itself is exercised indirectly by the
 * existing session integration tests; here we focus on the summary string the
 * Realtime model sees.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyApproval,
    detectRiskLabels,
    isCritical,
    mustBlockLlmDetail,
    type PolicyInput,
} from "../src/approval-policy.js";
import { analyzeCommand } from "../src/approval-sanitize.js";
import { getVoiceStrings } from "../src/i18n/voice-strings.js";
import type { RiskLabel, StructuralSignal, VerbRiskLabel } from "../src/approval-risk-labels.js";

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
    const { summary } = classifyApproval(
        baseInput({ params: { command: "cat README.md", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(summary, "cat README.md の承認依頼です。");
});

test("commandExecution: summary embeds verb + basenamed args (en)", () => {
    const { summary } = classifyApproval(
        baseInput({ params: { command: "cat README.md", cwd: "/ws" } }),
        enStrings,
    );
    assert.equal(summary, "Codex is asking to run: cat README.md.");
});

test("commandExecution: array params basename path-like args", () => {
    const { summary } = classifyApproval(
        baseInput({ params: { command: ["node", "/tmp/foo"], cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(summary, "node foo の承認依頼です。");
});

test("commandExecution: env-like values are redacted in the audio summary", () => {
    const { summary } = classifyApproval(
        baseInput({ params: { command: "FOO_TOKEN=abc echo x", cwd: "/ws" } }),
        jaStrings,
    );
    assert.ok(summary.includes("FOO_TOKEN=<redacted>"), summary);
    assert.ok(!summary.includes("FOO_TOKEN=abc"), summary);
});

test("detectRiskLabels: verb labels are derived from critical patterns", () => {
    const cases: Array<{ command: string; label: VerbRiskLabel }> = [
        { command: "rm README.md", label: "file-delete" },
        { command: "dd if=a of=b", label: "device-write" },
        { command: "mkfs /dev/sdb1", label: "filesystem-format" },
        { command: "git reset --hard HEAD", label: "git-reset-hard" },
        { command: "git clean -f -d", label: "git-clean-force" },
        { command: "chmod 777 script.sh", label: "permission-change" },
        { command: "shutdown now", label: "shutdown-reboot" },
        { command: ":(){:|:&};:", label: "fork-bomb" },
        { command: "sudo id", label: "privileged" },
        { command: "git push origin main", label: "git-push" },
        { command: "curl https://example.com", label: "network-fetch" },
        { command: "ssh host", label: "remote-shell" },
    ];

    for (const { command, label } of cases) {
        const result = detectRiskLabels(command, analyzeCommand(command));
        assert.ok(result.riskLabels.includes(label), `${command}: ${label}`);
        assert.ok(result.matchedCriticalPatterns.length > 0, `${command}: matched pattern`);
    }
});

test("detectRiskLabels: structural signals and auxiliary backtick signal are exposed", () => {
    const structuralCases: Array<{ command: string; signal: StructuralSignal }> = [
        { command: "bash -lc 'echo hi'", signal: "shell-wrapper" },
        { command: "echo $(date)", signal: "command-substitution" },
        { command: "echo $PATH", signal: "variable-expansion" },
        { command: "ls *.ts", signal: "wildcard-expansion" },
        { command: "echo 'hello'", signal: "quoted-token" },
        { command: "echo hi > out.txt", signal: "redirect" },
        { command: "find . -exec echo {} +", signal: "find-exec" },
        { command: "echo a && echo b", signal: "truncated" },
        { command: "cmd a b c d e", signal: "overflowed" },
    ];

    for (const { command, signal } of structuralCases) {
        const result = detectRiskLabels(command, analyzeCommand(command));
        assert.ok(result.riskLabels.includes(signal), `${command}: ${signal}`);
        assert.ok(result.structuralSignals.includes(signal), `${command}: structural ${signal}`);
    }

    const backtick = detectRiskLabels("echo `pwd`", analyzeCommand("echo `pwd`"));
    assert.deepEqual(backtick.auxiliarySignals, ["command-substitution-backtick"]);

    const dollarParen = detectRiskLabels("echo $(pwd)", analyzeCommand("echo $(pwd)"));
    assert.deepEqual(dollarParen.auxiliarySignals, []);
});

test("isCritical: boundary cases", () => {
    const cases: Array<{ labels: RiskLabel[]; expected: boolean }> = [
        { labels: ["file-delete"], expected: true },
        { labels: ["privileged"], expected: true },
        { labels: ["shell-wrapper"], expected: true },
        { labels: ["wildcard-expansion"], expected: false },
        { labels: ["wildcard-expansion", "file-delete"], expected: true },
        { labels: ["wildcard-expansion", "permission-change"], expected: true },
        { labels: ["quoted-token"], expected: false },
        { labels: ["variable-expansion"], expected: false },
        { labels: ["truncated"], expected: false },
        { labels: [], expected: false },
    ];

    for (const { labels, expected } of cases) {
        assert.equal(isCritical(labels), expected, labels.join(","));
    }
});

test("mustBlockLlmDetail: boundary cases", () => {
    const cases: Array<{ labels: RiskLabel[]; expected: boolean }> = [
        { labels: ["file-delete"], expected: true },
        { labels: ["privileged"], expected: true },
        { labels: ["shell-wrapper"], expected: true },
        { labels: ["truncated"], expected: true },
        { labels: ["variable-expansion"], expected: true },
        { labels: ["redirect"], expected: true },
        { labels: ["overflowed"], expected: true },
        { labels: ["quoted-token"], expected: false },
        { labels: [], expected: false },
    ];

    for (const { labels, expected } of cases) {
        assert.equal(mustBlockLlmDetail(labels), expected, labels.join(","));
    }
});

test("classifyApproval: commandExecution includes risk metadata for risky and safe commands", () => {
    const risky = classifyApproval(
        baseInput({ params: { command: "rm README.md", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(risky.verdict, "escalate");
    assert.ok(risky.riskLabels?.includes("file-delete"));
    assert.deepEqual(risky.structuralSignals, []);
    assert.deepEqual(risky.auxiliarySignals, []);
    assert.equal(risky.llmDetailBlocked, true);
    assert.ok((risky.matchedCriticalPatterns?.length ?? 0) > 0);

    const safe = classifyApproval(
        baseInput({ params: { command: "ls -la", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(safe.verdict, "auto-accept");
    assert.deepEqual(safe.riskLabels, []);
    assert.deepEqual(safe.matchedCriticalPatterns, []);
    assert.deepEqual(safe.structuralSignals, []);
    assert.deepEqual(safe.auxiliarySignals, []);
    assert.equal(safe.llmDetailBlocked, false);
});

test("classifyApproval: verdict connects structural risk without escalating variable-only commands", () => {
    const structural = classifyApproval(
        baseInput({ params: { command: "bash -lc 'docker rmi $img'", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(structural.verdict, "escalate");
    assert.ok(structural.riskLabels?.includes("shell-wrapper"));

    const variableOnly = classifyApproval(
        baseInput({ params: { command: "echo $PATH", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(variableOnly.verdict, "auto-accept");
    assert.deepEqual(variableOnly.riskLabels, ["variable-expansion"]);
    assert.equal(variableOnly.llmDetailBlocked, true);

    const commandSubstitution = classifyApproval(
        baseInput({ params: { command: "echo $(date)", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(commandSubstitution.verdict, "escalate");

    for (const command of ["ls -la", "git status", "pwd"]) {
        const result = classifyApproval(baseInput({ params: { command, cwd: "/ws" } }), jaStrings);
        assert.equal(result.verdict, "auto-accept", command);
        assert.deepEqual(result.riskLabels, [], command);
    }
});

test("summarize: risky, truncated, routine, and humanReadable priority branches", () => {
    const rm = classifyApproval(
        baseInput({ params: { command: "rm README.md", cwd: "/ws" } }),
        jaStrings,
    );
    assert.ok(rm.summary.includes("破壊的"), rm.summary);

    const findExec = classifyApproval(
        baseInput({ params: { command: "bash -lc 'find . -exec rm -rf {} +'", cwd: "/ws" } }),
        jaStrings,
    );
    assert.ok(findExec.summary.includes("破壊的"), findExec.summary);

    const longFind = classifyApproval(
        baseInput({
            params: { command: "find . -name '*.md' -type f -print", cwd: "/ws" },
        }),
        jaStrings,
    );
    assert.ok(longFind.summary.includes("複数ステップ"), longFind.summary);

    const routine = classifyApproval(
        baseInput({ params: { command: "ls -la", cwd: "/ws" } }),
        jaStrings,
    );
    assert.equal(routine.summary, "ls -la の承認依頼です。");

    const riskyHuman = classifyApproval(
        baseInput({
            params: {
                command: "rm README.md",
                humanReadable: "ユーザー向けの別説明",
                cwd: "/ws",
            },
        }),
        jaStrings,
    );
    assert.ok(riskyHuman.summary.includes("破壊的"), riskyHuman.summary);
    assert.ok(!riskyHuman.summary.includes("ユーザー向けの別説明"), riskyHuman.summary);

    const safeHuman = classifyApproval(
        baseInput({
            params: {
                command: "ls -la",
                humanReadable: "ユーザー向けの別説明",
                cwd: "/ws",
            },
        }),
        jaStrings,
    );
    assert.ok(safeHuman.summary.includes("ユーザー向けの別説明"), safeHuman.summary);
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
    assert.equal(
        summary,
        "複数ステップを含むコマンドの承認依頼です。詳細を画面で確認してから、はい か いいえ で答えてください。",
    );
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
    assert.equal(
        summary,
        "複数ステップを含むコマンドの承認依頼です。詳細を画面で確認してから、はい か いいえ で答えてください。",
    );
});

test("AC-1: bash -lc 内の find -exec rm -rf で音声サマリに「破壊的」が含まれる", () => {
    const policy = classifyApproval(
        baseInput({
            method: "shell",
            params: {
                command:
                    "/bin/bash -lc 'find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && test -z \"$(find . -mindepth 1 -print -quit)\"'",
            },
        }),
        jaStrings,
    );
    assert.equal(policy.verdict, "escalate");
    assert.match(policy.summary, /破壊的/);
    assert.ok(policy.riskLabels?.includes("shell-wrapper"));
    assert.ok(policy.riskLabels?.includes("file-delete"));
});

test("AC-3: rm README.md は file-delete を含む riskLabels で escalate", () => {
    const policy = classifyApproval(
        baseInput({ method: "shell", params: { command: "rm README.md" } }),
        jaStrings,
    );
    assert.equal(policy.verdict, "escalate");
    assert.ok(policy.riskLabels?.includes("file-delete"));
    assert.match(policy.summary, /破壊的/);
});

test("AC-4: ls / git status / pwd は auto-accept で commandExec 経路", () => {
    const cases = ["ls -la", "git status -s", "pwd"];
    for (const command of cases) {
        const policy = classifyApproval(
            baseInput({ method: "shell", params: { command } }),
            jaStrings,
        );
        assert.equal(policy.verdict, "auto-accept", command);
        assert.deepEqual(policy.riskLabels, [], command);
        assert.doesNotMatch(policy.summary, /破壊的|複数ステップ/, command);
    }
});

test("AC-5: find . -name '*.md' のような切り捨て発生コマンドは commandExecTruncated", () => {
    const policy = classifyApproval(
        baseInput({ method: "shell", params: { command: "find . -name '*.md' -type f" } }),
        jaStrings,
    );
    assert.equal(policy.verdict, "escalate");
    assert.match(policy.summary, /複数ステップ/);
    assert.ok(policy.riskLabels?.includes("overflowed"));
});

test("false positive 防止: rm-staging.sh / ls / git status / pwd / echo $PATH は escalate されない", () => {
    const cases = [
        "./rm-staging.sh deploy",
        "ls -la",
        "git status",
        "git status -s",
        "pwd",
        "echo $PATH",
        'echo "hello world"',
    ];
    for (const command of cases) {
        const policy = classifyApproval(
            baseInput({ method: "shell", params: { command } }),
            jaStrings,
        );
        assert.equal(policy.verdict, "auto-accept", `${command} should auto-accept`);
    }
});

test("verdict 接続: 構造的 critical コマンドは verb 辞書外でも escalate", () => {
    const policy = classifyApproval(
        baseInput({ method: "shell", params: { command: "bash -lc 'docker rmi $img'" } }),
        jaStrings,
    );
    assert.equal(policy.verdict, "escalate");
    assert.ok(policy.structuralSignals?.includes("shell-wrapper"));
});

test("verdict 接続: variable-expansion 単独は auto-accept (echo $PATH 等)", () => {
    const policy = classifyApproval(
        baseInput({ method: "shell", params: { command: "echo $PATH" } }),
        jaStrings,
    );
    assert.equal(policy.verdict, "auto-accept");
});

test("auxiliarySignals: backtick 形式の command-substitution が記録される", () => {
    const policy = classifyApproval(
        baseInput({ method: "shell", params: { command: "echo `whoami`" } }),
        jaStrings,
    );
    assert.ok(policy.auxiliarySignals?.includes("command-substitution-backtick"));
    assert.ok(policy.structuralSignals?.includes("command-substitution"));
});
