import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, enMessages, jaMessages, renderLoc } from "./index.js";

describe("client i18n dictionaries", () => {
    it("keeps en and ja on the same key set", () => {
        expect(Object.keys(jaMessages).sort()).toEqual(Object.keys(enMessages).sort());
    });

    it("resolves keys with the selected locale and interpolates params", () => {
        expect(createTranslator("en")("connection.button.start")).toBe(
            "Connect and start conversation",
        );
        expect(createTranslator("ja")("connection.button.start")).toBe("接続して会話開始");
        expect(createTranslator("en")("app.error.connectFailed", { message: "boom" })).toBe(
            "Connection failed: boom",
        );
    });
});

describe("renderLoc", () => {
    it("returns raw text unchanged", () => {
        expect(renderLoc("en", { text: "<b>plain text</b>" })).toBe("<b>plain text</b>");
    });

    it("resolves loc keys through the selected dictionary", () => {
        expect(renderLoc("ja", { loc: { key: "progress.waiting" } })).toBe("待機中");
        expect(
            renderLoc("en", {
                loc: { key: "app.error.connectFailed", params: { message: "boom" } },
            }),
        ).toBe("Connection failed: boom");
    });

    it("warns and returns a visible fallback for unknown keys", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(renderLoc("en", { loc: { key: "missing.key" } })).toBe("[missing:missing.key]");
        expect(warn).toHaveBeenCalledWith("Unknown i18n key: missing.key");

        warn.mockRestore();
    });

    it("does not use dangerouslySetInnerHTML", () => {
        const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
        expect(source).not.toContain("dangerouslySetInnerHTML");
    });
});
