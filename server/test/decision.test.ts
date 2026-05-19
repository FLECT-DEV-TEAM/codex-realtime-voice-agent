import assert from "node:assert/strict";
import test from "node:test";
import { classifyApprovalUtterance, isUserQuestion } from "../src/i18n/decision.js";
import type { ConversationLanguage } from "../src/i18n/conversation-language.js";

test("classifyApprovalUtterance handles ja/en/auto decisions conservatively", () => {
    const cases: Array<[ConversationLanguage, string, "accept" | "refuse" | null]> = [
        ["ja", "はい", "accept"],
        ["ja", "実行して", "accept"],
        ["ja", "進めて", "accept"],
        ["ja", "お願いします", "accept"],
        ["ja", "やめて", "refuse"],
        ["ja", "大丈夫", "accept"],
        ["ja", "大丈夫じゃない", "refuse"],
        ["ja", "大丈夫ではない", "refuse"],
        ["ja", "進めてほしくない", "refuse"],
        ["ja", "実行してほしくない", "refuse"],
        ["ja", "大丈夫とは思わない", "refuse"],
        ["ja", "お願いしたくない", "refuse"],
        ["ja", "これは大丈夫ですかね?", null],
        ["ja", "はい？", null],
        ["ja", "はい、これはかなり長い説明を含む返事なので判定しない", null],
        ["en", "yes", "accept"],
        ["en", "go ahead", "accept"],
        ["en", "do it", "accept"],
        ["en", "no", "refuse"],
        ["en", "nope", "refuse"],
        ["en", "cancel that", "refuse"],
        ["en", "another", null],
        ["en", "knot", null],
        ["en", "is that safe?", null],
        ["en", "can you proceed?", null],
        ["auto", "はい", "accept"],
        ["auto", "nope", "refuse"],
        ["auto", "実行してほしくない", "refuse"],
        ["auto", "不要执行", "refuse"],
        ["auto", "大丈夫じゃないけど進めて", "refuse"],
        ["auto", "네", "accept"],
        ["auto", "好的", "accept"],
        ["auto", "sí", "accept"],
        ["auto", "sí gracias", null],
        ["auto", "oui", "accept"],
        ["auto", "ja", "accept"],
        ["auto", "아니요", "refuse"],
        ["auto", "不要", "refuse"],
        ["auto", "non", "refuse"],
        ["auto", "nein", "refuse"],
        ["auto", "是什么", null],
        ["auto", "这是什么", null],
        ["auto", "해당 파일 뭐야", null],
        ["auto", "해", null],
        ["auto", "해당", null],
        ["auto", "好的吗", null],
        ["auto", "Kannst du ja wirklich ausführen?", null],
        ["ja", "네", null],
        ["en", "sí", null],
        ["en", "de ja vu", null],
        ["en", "es no bueno", "refuse"],
    ];

    for (const [lang, input, expected] of cases) {
        assert.equal(classifyApprovalUtterance(input, lang), expected, `${lang}: ${input}`);
    }
});

test("isUserQuestion uses ja/en question rules for every language mode", () => {
    assert.equal(isUserQuestion("これは何ですか?", "auto"), true);
    assert.equal(isUserQuestion("what will change", "auto"), true);
    assert.equal(isUserQuestion("please continue", "auto"), false);
});
