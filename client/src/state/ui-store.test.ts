import { describe, expect, it } from "vitest";
import { SETTINGS_STORE_PERSIST_NAME } from "./store.js";
import { detectInitialUiLocale, UI_STORE_PERSIST_NAME } from "./ui-store.js";

describe("detectInitialUiLocale", () => {
    it("detects ja only for navigator languages starting with ja", () => {
        expect(detectInitialUiLocale("ja-JP")).toBe("ja");
        expect(detectInitialUiLocale("en-US")).toBe("en");
        expect(detectInitialUiLocale(undefined)).toBe("en");
        expect(detectInitialUiLocale("fr")).toBe("en");
    });

    it("uses a separate persist key from session settings", () => {
        expect(UI_STORE_PERSIST_NAME).toBe("codex-realtime-voice-agent.ui");
        expect(UI_STORE_PERSIST_NAME).not.toBe(SETTINGS_STORE_PERSIST_NAME);
    });
});
