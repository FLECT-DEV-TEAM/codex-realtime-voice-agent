import assert from "node:assert/strict";
import test from "node:test";
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
