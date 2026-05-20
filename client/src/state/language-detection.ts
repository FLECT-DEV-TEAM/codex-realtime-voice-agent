export type UiLocale = "en" | "ja";

export const SUPPORTED_UI_LOCALES = ["en", "ja"] as const;
export const SUPPORTED_TRANSCRIPTION_LANGUAGES = [
    "ja",
    "en",
    "ko",
    "zh",
    "es",
    "fr",
    "de",
] as const;

export type SupportedTranscriptionLanguage = (typeof SUPPORTED_TRANSCRIPTION_LANGUAGES)[number];

function extractPrimarySubtag(tag: string): string {
    return tag.toLowerCase().replace("_", "-").split("-")[0];
}

function normalizeLanguageList(input?: readonly string[] | string): string[] {
    if (typeof input === "string") return [input];
    if (Array.isArray(input)) return [...input];
    return [];
}

export function readNavigatorLanguages(): readonly string[] {
    if (typeof navigator === "undefined") return [];
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return navigator.languages;
    }
    if (typeof navigator.language === "string") return [navigator.language];
    return [];
}

export function detectInitialUiLocale(input?: readonly string[] | string): UiLocale {
    for (const tag of normalizeLanguageList(input)) {
        const primarySubtag = extractPrimarySubtag(tag);
        if ((SUPPORTED_UI_LOCALES as readonly string[]).includes(primarySubtag)) {
            return primarySubtag as UiLocale;
        }
    }
    return "en";
}

export function detectInitialTranscriptionLanguage(
    input?: readonly string[] | string,
): SupportedTranscriptionLanguage | "" {
    for (const tag of normalizeLanguageList(input)) {
        const primarySubtag = extractPrimarySubtag(tag);
        if ((SUPPORTED_TRANSCRIPTION_LANGUAGES as readonly string[]).includes(primarySubtag)) {
            return primarySubtag as SupportedTranscriptionLanguage;
        }
    }
    return "";
}
