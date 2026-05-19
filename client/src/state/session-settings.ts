import type { SessionSettings } from "../types/messages.js";

type SessionSettingsSource = Pick<
    SessionSettings,
    | "voiceProvider"
    | "model"
    | "voice"
    | "instructionsExtra"
    | "transcriptionModel"
    | "transcriptionLanguage"
    | "codexReasoningEffort"
    | "noiseReduction"
>;

export function buildSessionSettingsFromStore(source: SessionSettingsSource): SessionSettings {
    return {
        voiceProvider: source.voiceProvider,
        model: source.model,
        voice: source.voice,
        instructionsExtra: source.instructionsExtra,
        transcriptionModel: source.transcriptionModel,
        transcriptionLanguage: source.transcriptionLanguage,
        codexReasoningEffort: source.codexReasoningEffort,
        noiseReduction: source.noiseReduction,
    };
}
