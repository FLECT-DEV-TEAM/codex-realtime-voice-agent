import { describe, expect, it } from "vitest";
import { buildSessionSettingsFromStore } from "./session-settings.js";

describe("buildSessionSettingsFromStore", () => {
    it("returns exactly the SessionSettings wire keys", () => {
        const source = {
            voiceProvider: "openai",
            model: "gpt-realtime-2",
            voice: "marin",
            instructionsExtra: "extra",
            transcriptionModel: "gpt-4o-transcribe",
            transcriptionLanguage: "ja",
            codexReasoningEffort: "medium",
            noiseReduction: "near_field",
            uiLocale: "en",
        } as const;
        const settings = buildSessionSettingsFromStore(source);

        expect(Object.keys(settings).sort()).toEqual(
            [
                "voiceProvider",
                "model",
                "voice",
                "instructionsExtra",
                "transcriptionModel",
                "transcriptionLanguage",
                "codexReasoningEffort",
                "noiseReduction",
            ].sort(),
        );
        expect(settings).toHaveProperty("noiseReduction", "near_field");
        expect(settings).not.toHaveProperty("uiLocale");
    });
});
