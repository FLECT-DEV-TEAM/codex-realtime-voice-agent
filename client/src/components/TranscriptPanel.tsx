import { useEffect, useRef } from "react";
import { useSessionStore } from "../state/store.js";

/**
 * Scrolling transcript. Auto-scrolls to bottom when new content arrives
 * unless the user has scrolled up (preserves manual scroll position).
 * A footer mirrors the progress panel's footer and shows cumulative
 * Realtime token usage + estimated cost.
 */
export const TranscriptPanel = () => {
    const transcript = useSessionStore((s) => s.transcript);
    const approvals = useSessionStore((s) => s.approvalNotices);
    const realtimeUsage = useSessionStore((s) => s.realtimeUsage);
    const listRef = useRef<HTMLDivElement | null>(null);
    const stickRef = useRef(true);

    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        if (stickRef.current) el.scrollTop = el.scrollHeight;
    }, [transcript, approvals]);

    const onScroll = (): void => {
        const el = listRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        stickRef.current = atBottom;
    };

    // Merge transcript + approval notices on the timeline for chronological display.
    const merged = [
        ...transcript.map((t) => ({ ...t, _kind: "transcript" as const })),
        ...approvals.map((a) => ({ ...a, _kind: "approval" as const })),
    ].sort((a, b) => a.timestamp - b.timestamp);

    const rt = realtimeUsage?.usage;

    return (
        <>
            <div className="transcript" ref={listRef} onScroll={onScroll}>
                {merged.length === 0 && (
                    <div className="transcript-empty">まだ会話はありません。</div>
                )}
                {merged.map((item) => {
                    if (item._kind === "approval") {
                        return (
                            <div
                                className="transcript-line transcript-line--approval"
                                key={item.id}
                            >
                                <span className="transcript-tag">[approval]</span>
                                <span>{item.summary}</span>
                            </div>
                        );
                    }
                    return (
                        <div
                            className={`transcript-line transcript-line--${item.role}`}
                            key={item.id}
                        >
                            <span className="transcript-tag">
                                {item.role === "user" ? "you" : "agent"}
                            </span>
                            <span>{item.text}</span>
                        </div>
                    );
                })}
            </div>
            {realtimeUsage && rt && (
                <div className="panel-footer">
                    <div className="panel-footer-row">
                        Realtime: 累計 <code>{rt.totalTokens.toLocaleString()}</code> トークン 約{" "}
                        <code>${realtimeUsage.costUsd.toFixed(4)}</code>
                    </div>
                    <div className="panel-footer-row">
                        入力: text{" "}
                        <code>
                            {Math.max(
                                0,
                                rt.inputTextTokens - rt.inputCachedTextTokens,
                            ).toLocaleString()}
                        </code>{" "}
                        (cached <code>{rt.inputCachedTextTokens.toLocaleString()}</code>) / audio{" "}
                        <code>
                            {Math.max(
                                0,
                                rt.inputAudioTokens - rt.inputCachedAudioTokens,
                            ).toLocaleString()}
                        </code>{" "}
                        (cached <code>{rt.inputCachedAudioTokens.toLocaleString()}</code>){" "}出力:
                        text <code>{rt.outputTextTokens.toLocaleString()}</code> / audio{" "}
                        <code>{rt.outputAudioTokens.toLocaleString()}</code>
                    </div>
                </div>
            )}
        </>
    );
};
