import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UiLocale = "en" | "ja";

export const UI_STORE_PERSIST_NAME = "codex-realtime-voice-agent.ui";

export function detectInitialUiLocale(language?: string): UiLocale {
    if (typeof language !== "string") return "en";
    return language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

function readNavigatorLanguage(): string | undefined {
    return typeof navigator === "undefined" ? undefined : navigator.language;
}

interface UiStore {
    uiLocale: UiLocale;
    setUiLocale: (uiLocale: UiLocale) => void;
}

export const useUiStore = create<UiStore>()(
    persist(
        (set) => ({
            uiLocale: detectInitialUiLocale(readNavigatorLanguage()),
            setUiLocale: (uiLocale) => set({ uiLocale }),
        }),
        {
            name: UI_STORE_PERSIST_NAME,
            version: 1,
        },
    ),
);
