import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../state/store.js";
import { useT, useUiLocale } from "../i18n/index.js";

/**
 * Codex progress feed — auto-scroll, level-coloured rows.
 */
export const ProgressLogPanel = () => {
    const t = useT();
    const uiLocale = useUiLocale();
    const progress = useSessionStore((s) => s.progressLog);
    const status = useSessionStore((s) => s.codexStatus);
    const codexTokenUsage = useSessionStore((s) => s.codexTokenUsage);
    const ref = useRef<HTMLDivElement | null>(null);
    const stickRef = useRef(true);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (stickRef.current) el.scrollTop = el.scrollHeight;
    }, [progress]);

    useEffect(() => {
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [status?.turnStartedAt, status?.lastEventAt]);

    const onScroll = (): void => {
        const el = ref.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    const turnElapsedSec =
        status?.turnStartedAt == null
            ? null
            : Math.max(0, Math.floor((now - status.turnStartedAt) / 1000));
    const idleElapsedSec =
        status?.lastEventAt == null
            ? null
            : Math.max(0, Math.floor((now - status.lastEventAt) / 1000));

    const ctxInput = codexTokenUsage?.last.inputTokens ?? 0;
    const ctxWindow = codexTokenUsage?.modelContextWindow ?? null;
    const ctxCumulative = codexTokenUsage?.total.totalTokens ?? 0;
    const ctxPercent =
        ctxWindow && ctxWindow > 0 ? ((ctxInput / ctxWindow) * 100).toFixed(1) : null;

    return (
        <>
            <div className="progress-log" ref={ref} onScroll={onScroll}>
                {progress.length === 0 && (
                    <div className="progress-empty">{t("progress.empty")}</div>
                )}
                {progress.map((p) => (
                    <div className={`progress-line progress-line--${p.level}`} key={p.id}>
                        <span className="progress-time">
                            {new Date(p.timestamp).toLocaleTimeString(uiLocale)}
                        </span>
                        <span className="progress-text">{p.text}</span>
                    </div>
                ))}
            </div>
            <div className="panel-footer">
                <div className="panel-footer-row">
                    {t("progress.status")} {status?.text ?? t("progress.waiting")}
                </div>
                <div className="panel-footer-row panel-footer-row--metrics">
                    <span>
                        {t("progress.turnElapsed")} {turnElapsedSec ?? "-"} {t("progress.seconds")}
                    </span>
                    <span>
                        {t("progress.codexIdle")} {idleElapsedSec ?? "-"} {t("progress.seconds")}
                    </span>
                </div>
                {codexTokenUsage && (
                    <div className="panel-footer-row">
                        {t("progress.context")}{" "}
                        <code>
                            {ctxInput.toLocaleString(uiLocale)} /{" "}
                            {ctxWindow !== null
                                ? ctxWindow.toLocaleString(uiLocale)
                                : t("progress.unknownLimit")}
                        </code>{" "}
                        {t("progress.tokens")}
                        {ctxPercent ? (
                            <>
                                {" "}
                                (<code>{ctxPercent}%</code>)
                            </>
                        ) : null}{" "}
                        {t("progress.cumulative")}{" "}
                        <code>{ctxCumulative.toLocaleString(uiLocale)}</code> {t("progress.tokens")}
                    </div>
                )}
            </div>
        </>
    );
};
