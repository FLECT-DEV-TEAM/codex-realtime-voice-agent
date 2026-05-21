import assert from "node:assert/strict";
import test from "node:test";
import type { RiskLabel } from "../src/approval-risk-labels.js";
import { buildSystemInstructions, getVoiceStrings } from "../src/i18n/voice-strings.js";

const assertNonEmpty = (value: unknown, path: string): void => {
    if (typeof value === "string") {
        assert.notEqual(value.trim(), "", path);
        return;
    }
    if (typeof value === "function") {
        // Dispatch on path because arity alone can't distinguish between
        // `commandExec(tokens: string[])` and a generic 1-arg string fn.
        const result = path.endsWith(".fileChange")
            ? (value as (kind: "delete" | "modify", paths: string[]) => string)("modify", [
                  "src/app.ts",
              ])
            : path.endsWith(".commandExec")
              ? (value as (tokens: string[]) => string)(["sample"])
              : path.endsWith(".commandExecRisky")
                ? (value as (labels: RiskLabel[]) => string)(["shell-wrapper"])
                : path.endsWith(".commandExecTruncated")
                  ? (value as () => string)()
                  : value.length === 2
                    ? (value as (a: string, b: string) => string)("detail", "question")
                    : (value as (a: string) => string)("sample");
        assert.equal(typeof result, "string", path);
        assert.notEqual(result.trim(), "", path);
        return;
    }
    if (Array.isArray(value)) {
        assert.ok(value.length > 0, path);
        value.forEach((item, index) => assertNonEmpty(item, `${path}[${index}]`));
        return;
    }
    assert.equal(typeof value, "object", path);
    assert.notEqual(value, null, path);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assertNonEmpty(child, `${path}.${key}`);
    }
};

test("getVoiceStrings returns complete bundles and auto fallbacks", () => {
    const auto = getVoiceStrings("auto");
    for (const lang of ["en", "ja", "", "ko", "zh", "es", "fr", "de"] as const) {
        const strings = getVoiceStrings(lang);
        assertNonEmpty(strings, lang || "empty");
        if (lang === "" || ["ko", "zh", "es", "fr", "de"].includes(lang)) {
            assert.equal(strings, auto);
        }
    }
});

test("buildSystemInstructions auto tells the model to follow the user's language", () => {
    const instructions = buildSystemInstructions("auto");
    assert.match(instructions, /Reply in the language the user is speaking/);
    assert.match(instructions, /\[Codex progress\]/);
});

test("buildSystemInstructions and injected progress prefix share VoiceStrings source", () => {
    const ja = getVoiceStrings("ja");
    assert.match(
        buildSystemInstructions("ja"),
        new RegExp(ja.codexProgressPrefix.replace("[", "\\[").replace("]", "\\]")),
    );
});

test("summarize.commandExec returns a non-empty fallback for an empty token list", () => {
    // tokens=[] is the legitimate "we couldn't extract anything" path (e.g.
    // params.command undefined). It must still produce a speakable line.
    assert.equal(getVoiceStrings("ja").summarize.commandExec([]), "コマンド実行の承認依頼です。");
    assert.equal(
        getVoiceStrings("en").summarize.commandExec([]),
        "Codex is asking to run a command.",
    );
    assert.equal(
        getVoiceStrings("auto").summarize.commandExec([]),
        // auto inherits en (intro/rules differ, summarize does not).
        getVoiceStrings("en").summarize.commandExec([]),
    );
});

test("summarize.commandExec embeds tokens for the audio LLM", () => {
    assert.equal(
        getVoiceStrings("ja").summarize.commandExec(["rm", "README.md"]),
        "rm README.md の承認依頼です。",
    );
    assert.equal(
        getVoiceStrings("en").summarize.commandExec(["rm", "README.md"]),
        "Codex is asking to run: rm README.md.",
    );
});

test("summarize.fallback no longer points at a 'confirmation screen'", () => {
    // Regression guard for the stale "詳細は確認画面に表示します" / "shown in
    // the details" lines that v1 deliberately left in place — Phase 2 removes
    // them so the LLM no longer parrots a non-existent screen.
    const ja = getVoiceStrings("ja").summarize;
    const en = getVoiceStrings("en").summarize;
    assert.doesNotMatch(ja.commandExec(["ls"]), /確認画面/);
    assert.doesNotMatch(ja.fallback(""), /確認画面/);
    assert.doesNotMatch(en.commandExec(["ls"]), /shown in the details/);
    assert.doesNotMatch(en.fallback(""), /shown in the details/);
});

const allRiskLabels: RiskLabel[] = [
    "file-delete",
    "device-write",
    "filesystem-format",
    "git-reset-hard",
    "git-clean-force",
    "permission-change",
    "shutdown-reboot",
    "fork-bomb",
    "privileged",
    "git-push",
    "network-fetch",
    "remote-shell",
    "shell-wrapper",
    "command-substitution",
    "variable-expansion",
    "wildcard-expansion",
    "quoted-token",
    "redirect",
    "find-exec",
    "truncated",
    "overflowed",
];

const expectedJaLabelTerms: Record<RiskLabel, string> = {
    "file-delete": "ファイル削除",
    "device-write": "デバイス書き込み",
    "filesystem-format": "ファイルシステム初期化",
    "git-reset-hard": "git の強制リセット",
    "git-clean-force": "git の強制クリーン",
    "permission-change": "権限変更",
    "shutdown-reboot": "電源操作",
    "fork-bomb": "フォーク爆弾",
    privileged: "特権実行",
    "git-push": "git push",
    "network-fetch": "ネットワーク取得",
    "remote-shell": "リモート接続",
    "shell-wrapper": "シェル経由",
    "command-substitution": "コマンド置換",
    "variable-expansion": "変数展開",
    "wildcard-expansion": "ワイルドカード",
    "quoted-token": "引用符",
    redirect: "リダイレクト",
    "find-exec": "find -exec",
    truncated: "複数ステップ",
    overflowed: "トークン超過",
};

const expectedEnLabelTerms: Record<RiskLabel, string> = {
    "file-delete": "file delete",
    "device-write": "device write",
    "filesystem-format": "filesystem format",
    "git-reset-hard": "git hard reset",
    "git-clean-force": "git clean -f",
    "permission-change": "permission change",
    "shutdown-reboot": "shutdown/reboot",
    "fork-bomb": "fork bomb",
    privileged: "privileged",
    "git-push": "git push",
    "network-fetch": "network fetch",
    "remote-shell": "remote shell",
    "shell-wrapper": "shell wrapper",
    "command-substitution": "command substitution",
    "variable-expansion": "variable expansion",
    "wildcard-expansion": "wildcards",
    "quoted-token": "quoted token",
    redirect: "redirect",
    "find-exec": "find -exec",
    truncated: "multi-step",
    overflowed: "overflow",
};

const escapeRegExp = (value: string): string => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

const assertRiskyApprovalStrings = (
    lang: "ja" | "en" | "auto",
    expected: {
        destructive: RegExp;
        caution: RegExp;
        complex: RegExp;
        fileDelete: RegExp;
        shellWrapper: RegExp;
        empty: RegExp;
        truncated: RegExp;
        labelTerms: Record<RiskLabel, string>;
    },
): void => {
    const strings = getVoiceStrings(lang);
    assert.notEqual(strings.approval.question.riskyInstructions.trim(), "");
    assert.notEqual(strings.approval.clarify.blockedDetailInstructions.trim(), "");
    assert.notEqual(strings.approval.clarify.blockedDetailResponse.trim(), "");
    assert.equal(typeof strings.summarize.commandExecRisky, "function");
    assert.equal(typeof strings.summarize.commandExecTruncated, "function");

    assert.match(strings.summarize.commandExecRisky(["file-delete"]), expected.destructive);
    assert.match(strings.summarize.commandExecRisky(["privileged"]), expected.caution);
    assert.match(strings.summarize.commandExecRisky(["shell-wrapper"]), expected.complex);
    assert.match(
        strings.summarize.commandExecRisky(["file-delete", "privileged"]),
        expected.destructive,
    );

    const mixedLabels = strings.summarize.commandExecRisky(["file-delete", "shell-wrapper"]);
    assert.match(mixedLabels, expected.fileDelete);
    assert.match(mixedLabels, expected.shellWrapper);

    assert.match(strings.summarize.commandExecRisky([]), expected.empty);
    assert.match(strings.summarize.commandExecTruncated(), expected.truncated);
    assert.ok(strings.summarize.commandExecRisky(allRiskLabels).length <= 200);
    assert.doesNotMatch(strings.summarize.commandExecRisky(["file-delete"]), /file-delete/);

    for (const label of allRiskLabels) {
        assert.match(
            strings.summarize.commandExecRisky([label]),
            new RegExp(escapeRegExp(expected.labelTerms[label])),
            `${lang} ${label}`,
        );
    }
};

test("risky approval voice strings are complete for ja", () => {
    assertRiskyApprovalStrings("ja", {
        destructive: /破壊的/,
        caution: /注意/,
        complex: /複雑/,
        fileDelete: /ファイル削除/,
        shellWrapper: /シェル経由/,
        empty: /コマンドの承認依頼です。/,
        truncated: /複数ステップ/,
        labelTerms: expectedJaLabelTerms,
    });
});

test("risky approval voice strings are complete for en", () => {
    assertRiskyApprovalStrings("en", {
        destructive: /destructive/,
        caution: /caution/,
        complex: /complex/,
        fileDelete: /file delete/,
        shellWrapper: /shell wrapper/,
        empty: /command approval request/,
        truncated: /multi-step/,
        labelTerms: expectedEnLabelTerms,
    });
});

test("risky approval voice strings are complete for auto", () => {
    assertRiskyApprovalStrings("auto", {
        destructive: /destructive/,
        caution: /caution/,
        complex: /complex/,
        fileDelete: /file delete/,
        shellWrapper: /shell wrapper/,
        empty: /command approval request/,
        truncated: /multi-step/,
        labelTerms: expectedEnLabelTerms,
    });
});

test("AC-8: ja / en / auto すべてに riskyInstructions / blockedDetail* / commandExecRisky / commandExecTruncated が定義されている", () => {
    for (const lang of ["ja", "en", "auto"] as const) {
        const strings = getVoiceStrings(lang);
        assert.notEqual(strings.approval.question.riskyInstructions.trim(), "", lang);
        assert.notEqual(strings.approval.clarify.blockedDetailInstructions.trim(), "", lang);
        assert.notEqual(strings.approval.clarify.blockedDetailResponse.trim(), "", lang);
        assert.equal(typeof strings.summarize.commandExecRisky, "function", lang);
        assert.equal(typeof strings.summarize.commandExecTruncated, "function", lang);
    }
});
