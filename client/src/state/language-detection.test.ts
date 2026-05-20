import { afterEach, describe, expect, it, vi } from "vitest";
import {
    detectInitialTranscriptionLanguage,
    detectInitialUiLocale,
    readNavigatorLanguages,
    SUPPORTED_TRANSCRIPTION_LANGUAGES,
} from "./language-detection.js";

describe("detectInitialUiLocale", () => {
    it.each([
        ["ja-JP", "ja"],
        ["en-US", "en"],
        [undefined, "en"],
        ["fr", "en"],
        [["fr-FR", "ja-JP"], "ja"],
        [["en-GB", "fr-FR"], "en"],
        [["zh-CN", "ko-KR"], "en"],
        [[], "en"],
        ["ja_JP", "ja"],
        ["EN-us", "en"],
    ] as const)("detects %s as %s", (input, expected) => {
        expect(detectInitialUiLocale(input)).toBe(expected);
    });
});

describe("detectInitialTranscriptionLanguage", () => {
    it.each([
        ["ja-JP", "ja"],
        ["en-US", "en"],
        ["ko-KR", "ko"],
        ["zh-CN", "zh"],
        ["es-ES", "es"],
        ["fr-FR", "fr"],
        ["de-DE", "de"],
        ["ZH-tw", "zh"],
        ["pt-BR", ""],
        ["it", ""],
        [undefined, ""],
        [[], ""],
        [["pt-BR", "ja-JP"], "ja"],
        [["es-ES", "en-US"], "es"],
        [["it", "pt"], ""],
        ["ja_JP", "ja"],
    ] as const)("detects %s as %s", (input, expected) => {
        expect(detectInitialTranscriptionLanguage(input)).toBe(expected);
    });
});

describe("readNavigatorLanguages", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns an empty list without navigator", () => {
        vi.stubGlobal("navigator", undefined);

        expect(readNavigatorLanguages()).toEqual([]);
    });

    it("uses non-empty navigator.languages before navigator.language", () => {
        vi.stubGlobal("navigator", {
            languages: ["ko-KR", "en-US"],
            language: "ja-JP",
        });

        expect(readNavigatorLanguages()).toEqual(["ko-KR", "en-US"]);
    });

    it("falls back to navigator.language when navigator.languages is empty", () => {
        vi.stubGlobal("navigator", {
            languages: [],
            language: "ja-JP",
        });

        expect(readNavigatorLanguages()).toEqual(["ja-JP"]);
    });

    it("returns an empty list when navigator has no usable language fields", () => {
        vi.stubGlobal("navigator", {});

        expect(readNavigatorLanguages()).toEqual([]);
    });
});

describe("SUPPORTED_TRANSCRIPTION_LANGUAGES", () => {
    it("keeps the supported transcription languages in settings order", () => {
        expect(SUPPORTED_TRANSCRIPTION_LANGUAGES).toEqual([
            "ja",
            "en",
            "ko",
            "zh",
            "es",
            "fr",
            "de",
        ]);
    });
});
