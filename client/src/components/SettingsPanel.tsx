import { useSettingsStore } from "../state/store.js";

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
const TRANSCRIPTION_LANGUAGES: Array<{ value: string; label: string }> = [
    { value: "", label: "(自動判定)" },
    { value: "ja", label: "日本語 (ja)" },
    { value: "en", label: "English (en)" },
    { value: "ko", label: "한국어 (ko)" },
    { value: "zh", label: "中文 (zh)" },
    { value: "es", label: "Español (es)" },
    { value: "fr", label: "Français (fr)" },
    { value: "de", label: "Deutsch (de)" },
];
const NOISE_REDUCTION: Array<{ value: string; label: string }> = [
    { value: "near_field", label: "near_field (近接/ヘッドセット)" },
    { value: "far_field", label: "far_field (ノートPC/会議室)" },
    { value: "off", label: "off (無効)" },
];
const CODEX_EFFORTS: Array<{ value: string; label: string }> = [
    { value: "", label: "(設定ファイル既定)" },
    { value: "low", label: "low (高速)" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high (じっくり)" },
];

/**
 * SettingsPanel — STS (speech-to-speech) and STT (speech-to-text) lines,
 * plus an instructions textarea. Persisted to localStorage via zustand
 * persist middleware. Changes apply on the next session/start.
 */
export const SettingsPanel = () => {
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
                <span className="settings-group-label" title="Speech-to-Speech (STS)">
                    会話
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
                <span className="settings-group-label" title="Speech-to-Text (STT)">
                    書き起こし
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
                    <label htmlFor="stt-language">言語</label>
                    <select
                        id="stt-language"
                        value={transcriptionLanguage}
                        onChange={(e) => setSetting("transcriptionLanguage", e.target.value)}
                    >
                        {TRANSCRIPTION_LANGUAGES.map((l) => (
                            <option key={l.value} value={l.value}>
                                {l.label}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="settings-field">
                    <label htmlFor="stt-noise" title="OpenAI Realtime のみ。次回接続時に適用">
                        ノイズ低減
                    </label>
                    <select
                        id="stt-noise"
                        value={noiseReduction}
                        onChange={(e) => setSetting("noiseReduction", e.target.value)}
                    >
                        {NOISE_REDUCTION.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="settings-group">
                <span className="settings-group-label" title="Codex sub-agent">
                    Codex
                </span>
                <div className="settings-field">
                    <label htmlFor="codex-effort">Effort</label>
                    <select
                        id="codex-effort"
                        value={codexReasoningEffort}
                        onChange={(e) => setSetting("codexReasoningEffort", e.target.value)}
                    >
                        {CODEX_EFFORTS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="settings-group settings-group--column">
                <label htmlFor="instructions" className="settings-group-label">
                    追加システム指示
                </label>
                <textarea
                    id="instructions"
                    rows={3}
                    placeholder="(任意) このセッション特有の口調や注意点をここに書く"
                    value={instructionsExtra}
                    onChange={(e) => setSetting("instructionsExtra", e.target.value)}
                />
            </div>

            <div className="settings-actions">
                <button type="button" onClick={() => reset()}>
                    デフォルトに戻す
                </button>
            </div>
        </div>
    );
};
