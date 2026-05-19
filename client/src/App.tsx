import { useEffect, useRef } from "react";
import { ConnectionControls } from "./components/ConnectionControls.js";
import { TranscriptPanel } from "./components/TranscriptPanel.js";
import { ProgressLogPanel } from "./components/ProgressLogPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { AudioManager } from "./audio/audio-manager.js";
import { VoiceWsClient } from "./ws/client.js";
import { useSessionStore, useSettingsStore } from "./state/store.js";
import { buildSessionSettingsFromStore } from "./state/session-settings.js";

/**
 * Top-level component. Owns the AudioManager + VoiceWsClient lifecycle and
 * wires them to the zustand stores. The rest of the UI is read-only from
 * those stores.
 */
export const App = () => {
    const audioRef = useRef<AudioManager | null>(null);
    const wsRef = useRef<VoiceWsClient | null>(null);

    const sessionState = useSessionStore((s) => s.state);
    const setState = useSessionStore((s) => s.setState);
    const appendTranscript = useSessionStore((s) => s.appendTranscript);
    const appendProgress = useSessionStore((s) => s.appendProgress);
    const appendApprovalNotice = useSessionStore((s) => s.appendApprovalNotice);
    const setServerSettings = useSessionStore((s) => s.setServerSettings);
    const setCodexTurnId = useSessionStore((s) => s.setCodexTurnId);
    const setCodexStatus = useSessionStore((s) => s.setCodexStatus);
    const setCodexTokenUsage = useSessionStore((s) => s.setCodexTokenUsage);
    const setRealtimeUsage = useSessionStore((s) => s.setRealtimeUsage);
    const setError = useSessionStore((s) => s.setError);
    const clearLogs = useSessionStore((s) => s.clearLogs);
    const codexThreadId = useSessionStore((s) => s.codexThreadId);
    const codexTurnId = useSessionStore((s) => s.codexTurnId);
    // Subscribe to each field individually — selecting an object literal
    // would return a fresh reference on every render and force a re-subscribe
    // loop through useSyncExternalStore.
    const voiceProvider = useSettingsStore((s) => s.voiceProvider);
    const model = useSettingsStore((s) => s.model);
    const voice = useSettingsStore((s) => s.voice);
    const instructionsExtra = useSettingsStore((s) => s.instructionsExtra);
    const transcriptionModel = useSettingsStore((s) => s.transcriptionModel);
    const transcriptionLanguage = useSettingsStore((s) => s.transcriptionLanguage);
    const codexReasoningEffort = useSettingsStore((s) => s.codexReasoningEffort);
    const noiseReduction = useSettingsStore((s) => s.noiseReduction);
    const settings = buildSessionSettingsFromStore({
        voiceProvider,
        model,
        voice,
        instructionsExtra,
        transcriptionModel,
        transcriptionLanguage,
        codexReasoningEffort,
        noiseReduction,
    });

    const connectAndStart = async (): Promise<void> => {
        if (audioRef.current || wsRef.current) return;
        clearLogs();
        setError(null);
        setState("connecting", "WebSocket / mic を準備中...");

        try {
            // 1. Open audio first (mic permission prompt may appear).
            const audio = new AudioManager({
                wireRate: voiceProvider === "gemini" ? 16000 : 24000,
                onMicChunk: (chunk) => wsRef.current?.sendAudio(chunk),
            });
            await audio.start();
            audioRef.current = audio;

            // 2. Open WebSocket to server (same-origin via Vite proxy in dev).
            const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice`;
            const ws = new VoiceWsClient({
                onOpen: () => {
                    ws.send({ type: "session/start", settings });
                },
                onMessage: (msg) => {
                    switch (msg.type) {
                        case "session/status":
                            setState(msg.state, msg.message ?? null);
                            return;
                        case "transcript":
                            appendTranscript(msg.role, msg.text);
                            return;
                        case "codex/progress":
                            appendProgress(msg.text, msg.level, msg.streaming);
                            return;
                        case "codex/turn":
                            setCodexTurnId(msg.turnId);
                            return;
                        case "codex/status":
                            setCodexStatus(msg);
                            return;
                        case "codex/tokenUsage":
                            setCodexTokenUsage(msg.tokenUsage);
                            return;
                        case "realtime/tokenUsage":
                            setRealtimeUsage({ usage: msg.usage, costUsd: msg.costUsd });
                            return;
                        case "approval/notice":
                            appendApprovalNotice(msg.summary, msg.kind);
                            return;
                        case "audio/flush":
                            // Barge-in: drop everything queued for playback
                            // so the agent stops talking over the user.
                            audio.flushPlayback();
                            return;
                        case "settings":
                            setServerSettings(
                                msg.settings,
                                msg.codexThreadId,
                                msg.sessionId,
                                msg.logFile,
                            );
                            return;
                        case "error":
                            setError(msg.message);
                            if (msg.fatal) void stop();
                            return;
                    }
                },
                onAudio: (pcm) => audio.enqueuePlayback(pcm),
                onClose: () => {
                    setState("stopped", "サーバとの接続が閉じました");
                    void stop();
                },
                onError: () => setError("WebSocket error"),
            });
            ws.connect(wsUrl);
            wsRef.current = ws;
        } catch (err) {
            setError(`接続に失敗: ${(err as Error).message}`);
            setState("error", (err as Error).message);
            await stop();
        }
    };

    const stop = async (): Promise<void> => {
        try {
            wsRef.current?.send({ type: "session/stop" });
        } catch {
            /* ignore */
        }
        wsRef.current?.close();
        wsRef.current = null;
        await audioRef.current?.stop();
        audioRef.current = null;
        setState("stopped");
    };

    // Push settings updates to server when they change while a session is active.
    useEffect(() => {
        if (sessionState === "active" || sessionState === "ready") {
            wsRef.current?.send({ type: "settings/update", settings });
        }
    }, [
        settings.voiceProvider,
        settings.model,
        settings.voice,
        settings.instructionsExtra,
        settings.transcriptionModel,
        settings.transcriptionLanguage,
        settings.codexReasoningEffort,
        settings.noiseReduction,
    ]);

    // Cleanup on unmount.
    useEffect(() => {
        return () => {
            void stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="app">
            <header className="app-header">
                <h1>Codex Realtime Voice Agent</h1>
                <ConnectionControls onStart={connectAndStart} onStop={stop} />
            </header>
            <div className="app-body">
                <div className="panel-row panel-row--main">
                    <section className="panel panel--transcript">
                        <h2>Transcript</h2>
                        <TranscriptPanel />
                    </section>
                    <section className="panel panel--progress">
                        <h2>
                            Codex 進捗
                            {codexThreadId && (
                                <small className="panel-meta" title={codexThreadId}>
                                    {" "}
                                    thread: {codexThreadId.slice(0, 8)}…
                                </small>
                            )}
                            {codexTurnId && (
                                <small className="panel-meta" title={codexTurnId}>
                                    {" "}
                                    turn: {codexTurnId.slice(0, 8)}…
                                </small>
                            )}
                        </h2>
                        <ProgressLogPanel />
                    </section>
                </div>
                <div className="panel-row">
                    <section className="panel panel--settings">
                        <h2>Settings</h2>
                        <SettingsPanel />
                    </section>
                </div>
            </div>
        </div>
    );
};
