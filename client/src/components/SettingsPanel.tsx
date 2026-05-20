import { useSettingsStore } from "../state/store.js";
import { useT, type MessageKey } from "../i18n/index.js";
import {
    SUPPORTED_TRANSCRIPTION_LANGUAGES,
    SUPPORTED_UI_LOCALES,
    type SupportedTranscriptionLanguage,
    type UiLocale,
} from "../state/language-detection.js";
import { useUiStore } from "../state/ui-store.js";

const OPENAI_MODELS = ["gpt-realtime-2", "gpt-realtime-1.5", "gpt-realtime", "gpt-realtime-mini"];
const GEMINI_MODELS = [
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-preview-12-2025",
];
const OPENAI_VOICES = [
    "marin",
    "cedar",
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
];
const GEMINI_VOICES = ["Kore"];
const TRANSCRIPTION_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];
const UI_LANGUAGE_LABEL_KEYS: Record<UiLocale, MessageKey> = {
    en: "settings.uiLanguage.en",
    ja: "settings.uiLanguage.ja",
};
const UI_LANGUAGES: Array<{ value: UiLocale; labelKey: MessageKey }> = SUPPORTED_UI_LOCALES.map(
    (code) => ({ value: code, labelKey: UI_LANGUAGE_LABEL_KEYS[code] }),
);
const TRANSCRIPTION_LANGUAGE_LABEL_KEYS: Record<SupportedTranscriptionLanguage, MessageKey> = {
    ja: "settings.transcriptionLanguage.ja",
    en: "settings.transcriptionLanguage.en",
    ko: "settings.transcriptionLanguage.ko",
    zh: "settings.transcriptionLanguage.zh",
    es: "settings.transcriptionLanguage.es",
    fr: "settings.transcriptionLanguage.fr",
    de: "settings.transcriptionLanguage.de",
};
const TRANSCRIPTION_LANGUAGES: Array<{ value: string; labelKey: MessageKey }> = [
    { value: "", labelKey: "settings.transcriptionLanguage.auto" },
    ...SUPPORTED_TRANSCRIPTION_LANGUAGES.map((code) => ({
        value: code,
        labelKey: TRANSCRIPTION_LANGUAGE_LABEL_KEYS[code],
    })),
];
const NOISE_REDUCTION: Array<{ value: string; labelKey: MessageKey }> = [
    { value: "near_field", labelKey: "settings.noiseReduction.nearField" },
    { value: "far_field", labelKey: "settings.noiseReduction.farField" },
    { value: "off", labelKey: "settings.noiseReduction.off" },
];
const CODEX_EFFORTS: Array<{ value: string; labelKey: MessageKey }> = [
    { value: "", labelKey: "settings.codexEffort.default" },
    { value: "low", labelKey: "settings.codexEffort.low" },
    { value: "medium", labelKey: "settings.codexEffort.medium" },
    { value: "high", labelKey: "settings.codexEffort.high" },
];

/**
 * SettingsPanel — STS (speech-to-speech) and STT (speech-to-text) lines,
 * plus an instructions textarea. Persisted to localStorage via zustand
 * persist middleware. Changes apply on the next session/start.
 */
export const SettingsPanel = () => {
    const t = useT();
    const uiLocale = useUiStore((s) => s.uiLocale);
    const setUiLocale = useUiStore((s) => s.setUiLocale);
    const voiceProvider = useSettingsStore((s) => s.voiceProvider);
    const model = useSettingsStore((s) => s.model);
    const voice = useSettingsStore((s) => s.voice);
    const instructionsExtra = useSettingsStore((s) => s.instructionsExtra);
    const transcriptionModel = useSettingsStore((s) => s.transcriptionModel);
    const transcriptionLanguage = useSettingsStore((s) => s.transcriptionLanguage);
    const noiseReduction = useSettingsStore((s) => s.noiseReduction);
    const codexReasoningEffort = useSettingsStore((s) => s.codexReasoningEffort);
    const setSetting = useSettingsStore((s) => s.setSetting);
    const reset = useSettingsStore((s) => s.reset);
    const models = voiceProvider === "gemini" ? GEMINI_MODELS : OPENAI_MODELS;
    const voices = voiceProvider === "gemini" ? GEMINI_VOICES : OPENAI_VOICES;

    return (
        <div className="settings">
            <div className="settings-group">
                <span className="settings-group-label">{t("settings.label.uiLanguage")}</span>
                <div className="settings-field">
                    <label htmlFor="ui-language">{t("settings.label.uiLanguage")}</label>
                    <select
                        id="ui-language"
                        value={uiLocale}
                        onChange={(e) => setUiLocale(e.target.value as UiLocale)}
                    >
                        {UI_LANGUAGES.map((l) => (
                            <option key={l.value} value={l.value}>
                                {t(l.labelKey)}
                            </option>
                        ))}
                    </select>
                </div>
                <p className="settings-note">{t("settings.note.uiLanguage")}</p>
            </div>

            <div className="settings-group">
                <span className="settings-group-label" title={t("settings.title.sts")}>
                    {t("settings.group.conversation")}
                </span>
                <div className="settings-field">
                    <label htmlFor="sts-provider">Provider</label>
                    <select
                        id="sts-provider"
                        value={voiceProvider}
                        onChange={(e) => {
                            const next = e.target.value as "openai" | "gemini";
                            setSetting("voiceProvider", next);
                            setSetting(
                                "model",
                                next === "gemini" ? GEMINI_MODELS[0] : OPENAI_MODELS[0],
                            );
                            setSetting(
                                "voice",
                                next === "gemini" ? GEMINI_VOICES[0] : OPENAI_VOICES[0],
                            );
                        }}
                    >
                        <option value="openai">OpenAI Realtime</option>
                        <option value="gemini">Gemini Live</option>
                    </select>
                </div>
                <div className="settings-field">
                    <label htmlFor="sts-model">Model</label>
                    <select
                        id="sts-model"
                        value={model}
                        onChange={(e) => setSetting("model", e.target.value)}
                    >
                        {models.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="settings-field">
                    <label htmlFor="sts-voice">Voice</label>
                    <select
                        id="sts-voice"
                        value={voice}
                        onChange={(e) => setSetting("voice", e.target.value)}
                    >
                        {voices.map((v) => (
                            <option key={v} value={v}>
                                {v}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="settings-group">
                <span className="settings-group-label" title={t("settings.title.stt")}>
                    {t("settings.group.transcription")}
                </span>
                <div className="settings-field">
                    <label htmlFor="stt-model">Model</label>
                    <select
                        id="stt-model"
                        value={transcriptionModel}
                        onChange={(e) => setSetting("transcriptionModel", e.target.value)}
                    >
                        {TRANSCRIPTION_MODELS.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="settings-field">
                    <label htmlFor="stt-language">{t("settings.label.conversationLanguage")}</label>
                    <select
                        id="stt-language"
                        value={transcriptionLanguage}
                        onChange={(e) => setSetting("transcriptionLanguage", e.target.value)}
                    >
                        {TRANSCRIPTION_LANGUAGES.map((l) => (
                            <option key={l.value} value={l.value}>
                                {t(l.labelKey)}
                            </option>
                        ))}
                    </select>
                </div>
                <p className="settings-note">{t("settings.note.conversationLanguage")}</p>
                <div className="settings-field">
                    <label htmlFor="stt-noise" title={t("settings.title.noiseReduction")}>
                        {t("settings.label.noiseReduction")}
                    </label>
                    <select
                        id="stt-noise"
                        value={noiseReduction}
                        onChange={(e) => setSetting("noiseReduction", e.target.value)}
                    >
                        {NOISE_REDUCTION.map((o) => (
                            <option key={o.value} value={o.value}>
                                {t(o.labelKey)}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="settings-group">
                <span className="settings-group-label" title={t("settings.title.codex")}>
                    {t("settings.group.codex")}
                </span>
                <div className="settings-field">
                    <label htmlFor="codex-effort">{t("settings.label.effort")}</label>
                    <select
                        id="codex-effort"
                        value={codexReasoningEffort}
                        onChange={(e) => setSetting("codexReasoningEffort", e.target.value)}
                    >
                        {CODEX_EFFORTS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {t(o.labelKey)}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="settings-group settings-group--column">
                <label htmlFor="instructions" className="settings-group-label">
                    {t("settings.label.instructionsExtra")}
                </label>
                <textarea
                    id="instructions"
                    rows={3}
                    placeholder={t("settings.placeholder.instructionsExtra")}
                    value={instructionsExtra}
                    onChange={(e) => setSetting("instructionsExtra", e.target.value)}
                />
            </div>

            <div className="settings-actions">
                <button type="button" onClick={() => reset()}>
                    {t("settings.button.reset")}
                </button>
            </div>
        </div>
    );
};
