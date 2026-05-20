import { describe, expect, it, vi } from "vitest";
import { applyApprovalNotice, type ApprovalNoticeMessage } from "./approval-message-handler.js";

describe("applyApprovalNotice", () => {
    it("forwards summary, kind, and detail to the store deps verbatim", () => {
        const append = vi.fn();
        const msg: ApprovalNoticeMessage = {
            type: "approval/notice",
            summary: "rm README.md の承認依頼です。",
            kind: "commandExecution",
            detail: "種別: commandExecution\nコマンド: rm README.md",
        };
        applyApprovalNotice(msg, { appendApprovalNotice: append });
        expect(append).toHaveBeenCalledTimes(1);
        expect(append).toHaveBeenCalledWith({
            summary: "rm README.md の承認依頼です。",
            kind: "commandExecution",
            detail: "種別: commandExecution\nコマンド: rm README.md",
        });
    });

    it("passes detail through as undefined when the wire payload omits it", () => {
        const append = vi.fn();
        const msg: ApprovalNoticeMessage = {
            type: "approval/notice",
            summary: "Codex から承認依頼が届きました",
            kind: "permissions",
        };
        applyApprovalNotice(msg, { appendApprovalNotice: append });
        expect(append).toHaveBeenCalledTimes(1);
        const call = append.mock.calls[0]?.[0];
        expect(call).toMatchObject({
            summary: "Codex から承認依頼が届きました",
            kind: "permissions",
        });
        expect(call?.detail).toBeUndefined();
    });

    it("does not touch any other dependency (handler is scope-limited)", () => {
        // Scope-limited extraction (v4 must-3): the handler must not reach for
        // audio.flushPlayback, error.fatal stop(), or any other dep. The deps
        // shape itself enforces this — we only declare appendApprovalNotice.
        // This is a guard against future drift: if someone widens the deps
        // type, this test won't catch it, but the unit boundary stays clear.
        const append = vi.fn();
        applyApprovalNotice(
            { type: "approval/notice", summary: "s", kind: "k" },
            { appendApprovalNotice: append },
        );
        expect(append).toHaveBeenCalledOnce();
    });
});
