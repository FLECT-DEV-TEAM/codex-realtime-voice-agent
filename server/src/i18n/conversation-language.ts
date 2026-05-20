export type ConversationLanguage = "auto" | "ja" | "en";

export function normalizeConversationLanguage(value: string): ConversationLanguage {
    const normalized = value.trim().toLowerCase();
    if (normalized === "ja" || normalized === "en") return normalized;
    return "auto";
}
