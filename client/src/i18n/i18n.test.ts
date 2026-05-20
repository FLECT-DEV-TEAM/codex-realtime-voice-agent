import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, enMessages, jaMessages, renderLoc } from "./index.js";
import { useSessionStore } from "../state/store.js";

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

    it("contains every server LocKey", () => {
        const source = readFileSync(
            new URL("../../../server/src/i18n/loc-keys.ts", import.meta.url),
            "utf8",
        );
        const serverKeys = [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

        expect(serverKeys.length).toBeGreaterThan(0);
        for (const key of serverKeys) {
            expect(enMessages).toHaveProperty(key);
            expect(jaMessages).toHaveProperty(key);
        }
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

    it("keeps status, error, progress, and codex status reactive to locale changes", () => {
        const store = useSessionStore.getState();

        store.clearLogs();
        store.setState("connecting", { loc: { key: "app.connecting" } });
        store.setError({
            loc: { key: "app.error.connectFailed", params: { message: "boom" } },
        });
        store.appendProgress({ loc: { key: "server.progress.codexTransportClosed" } }, "error");
        store.setCodexStatus({
            loc: { key: "server.status.reasoning" },
            turnStartedAt: 1,
            lastEventAt: 2,
        });

        const state = useSessionStore.getState();
        expect(state.statusMessage).not.toBeNull();
        expect(state.error).not.toBeNull();
        expect(renderLoc("en", state.statusMessage!)).toBe("Preparing WebSocket / mic...");
        expect(renderLoc("ja", state.statusMessage!)).toBe("WebSocket / mic を準備中...");
        expect(renderLoc("en", state.error!)).toBe("Connection failed: boom");
        expect(renderLoc("ja", state.error!)).toBe("接続に失敗: boom");
        expect(renderLoc("en", state.progressLog[0].body)).toBe(
            "[Codex Transport] Process exited unexpectedly",
        );
        expect(renderLoc("ja", state.progressLog[0].body)).toBe(
            "[Codex Transport] プロセスが予期せず終了しました",
        );
        expect(renderLoc("en", { loc: state.codexStatus!.loc })).toBe("Reasoning");
        expect(renderLoc("ja", { loc: state.codexStatus!.loc })).toBe("推論中");
    });
});
