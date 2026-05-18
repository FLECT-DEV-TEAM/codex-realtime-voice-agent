import { useSessionStore } from "../state/store.js";

interface Props {
    onStart: () => void;
    onStop: () => void;
}

const STATE_LABEL: Record<string, string> = {
    idle: "停止中",
    connecting: "接続中…",
    ready: "準備完了",
    active: "通話中",
    stopping: "終了処理中…",
    stopped: "停止しました",
    error: "エラー",
};

const STATE_CLASS: Record<string, string> = {
    idle: "is-idle",
    connecting: "is-busy",
    ready: "is-ready",
    active: "is-active",
    stopping: "is-busy",
    stopped: "is-idle",
    error: "is-error",
};

export const ConnectionControls = ({ onStart, onStop }: Props) => {
    const state = useSessionStore((s) => s.state);
    const statusMessage = useSessionStore((s) => s.statusMessage);
    const error = useSessionStore((s) => s.error);
    const sessionId = useSessionStore((s) => s.sessionId);
    const logFile = useSessionStore((s) => s.logFile);

    const isLive = state === "connecting" || state === "ready" || state === "active";

    return (
        <div className="conn">
            <button
                type="button"
                className={`conn-btn ${isLive ? "conn-btn--stop" : "conn-btn--start"}`}
                onClick={isLive ? onStop : onStart}
                disabled={state === "stopping"}
            >
                {isLive ? "停止" : "接続して会話開始"}
            </button>
            <div className={`conn-status ${STATE_CLASS[state] ?? ""}`}>
                <strong>{STATE_LABEL[state] ?? state}</strong>
                {statusMessage && <span className="conn-msg"> — {statusMessage}</span>}
                {error && <span className="conn-msg conn-msg--err"> ⚠ {error}</span>}
                {sessionId && (
                    <span className="conn-thread" title={logFile ?? undefined}>
                        {" "}
                        session: {sessionId}
                    </span>
                )}
            </div>
        </div>
    );
};
