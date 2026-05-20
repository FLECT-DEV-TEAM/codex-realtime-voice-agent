import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemInstructions, getVoiceStrings } from "../src/i18n/voice-strings.js";

const assertNonEmpty = (value: unknown, path: string): void => {
    if (typeof value === "string") {
        assert.notEqual(value.trim(), "", path);
        return;
    }
    if (typeof value === "function") {
        const result = path.endsWith(".fileChange")
            ? (value as (kind: "delete" | "modify", paths: string[]) => string)("modify", [
                  "src/app.ts",
              ])
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
