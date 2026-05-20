import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationLanguage } from "./conversation-language.js";

test("normalizeConversationLanguage maps supported languages and falls back to auto", () => {
    const cases: Array<[string, "auto" | "ja" | "en"]> = [
        ["ja", "ja"],
        ["en", "en"],
        ["", "auto"],
        ["ko", "auto"],
        ["zh", "auto"],
        ["es", "auto"],
        ["fr", "auto"],
        ["de", "auto"],
        ["unknown", "auto"],
    ];

    for (const [input, expected] of cases) {
        assert.equal(normalizeConversationLanguage(input), expected);
    }
});
