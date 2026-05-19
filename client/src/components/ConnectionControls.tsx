import { useSessionStore } from "../state/store.js";
import { useT, type MessageKey } from "../i18n/index.js";

interface Props {
    onStart: () => void;
    onStop: () => void;
}

const STATE_LABEL_KEY: Record<string, MessageKey> = {
    idle: "connection.state.idle",
    connecting: "connection.state.connecting",
    ready: "connection.state.ready",
    active: "connection.state.active",
    stopping: "connection.state.stopping",
    stopped: "connection.state.stopped",
    error: "connection.state.error",
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
    const t = useT();
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
                {isLive ? t("connection.button.stop") : t("connection.button.start")}
            </button>
            <div className={`conn-status ${STATE_CLASS[state] ?? ""}`}>
                <strong>{STATE_LABEL_KEY[state] ? t(STATE_LABEL_KEY[state]) : state}</strong>
                {statusMessage && <span className="conn-msg"> — {statusMessage}</span>}
                {error && <span className="conn-msg conn-msg--err"> ⚠ {error}</span>}
                {sessionId && (
                    <span className="conn-thread" title={logFile ?? undefined}>
                        {" "}
                        {t("connection.session")} {sessionId}
                    </span>
                )}
            </div>
        </div>
    );
};
