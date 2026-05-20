import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
    detectInitialUiLocale,
    readNavigatorLanguages,
    type UiLocale,
} from "./language-detection.js";

export type { UiLocale } from "./language-detection.js";
export { detectInitialUiLocale } from "./language-detection.js";

export const UI_STORE_PERSIST_NAME = "codex-realtime-voice-agent.ui";

interface UiStore {
    uiLocale: UiLocale;
    setUiLocale: (uiLocale: UiLocale) => void;
    reset: () => void;
}

export const useUiStore = create<UiStore>()(
    persist(
        (set) => ({
            uiLocale: detectInitialUiLocale(readNavigatorLanguages()),
            setUiLocale: (uiLocale) => set({ uiLocale }),
            reset: () => set({ uiLocale: detectInitialUiLocale(readNavigatorLanguages()) }),
        }),
        {
            name: UI_STORE_PERSIST_NAME,
            version: 1,
        },
    ),
);
