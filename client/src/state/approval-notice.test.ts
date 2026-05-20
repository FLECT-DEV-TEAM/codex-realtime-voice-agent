import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore } from "./store.js";

const reset = (): void => {
    useSessionStore.setState({ approvalNotices: [] });
};

describe("appendApprovalNotice (object-arg form)", () => {
    beforeEach(reset);

    it("stores summary, kind, and detail when all three are provided", () => {
        useSessionStore.getState().appendApprovalNotice({
            summary: "rm README.md の承認依頼です。",
            kind: "commandExecution",
            detail: "種別: commandExecution\nコマンド: rm README.md",
        });
        const notices = useSessionStore.getState().approvalNotices;
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
            summary: "rm README.md の承認依頼です。",
            kind: "commandExecution",
            detail: "種別: commandExecution\nコマンド: rm README.md",
        });
        expect(notices[0]?.id).toBeTypeOf("string");
        expect(notices[0]?.timestamp).toBeTypeOf("number");
    });

    it("accepts notices without a detail field (idle escalation / pre-detail sources)", () => {
        useSessionStore.getState().appendApprovalNotice({
            summary: "Codex から N 秒応答がありません",
            kind: "idle",
        });
        const notice = useSessionStore.getState().approvalNotices[0];
        expect(notice?.detail).toBeUndefined();
        expect(notice?.summary).toBe("Codex から N 秒応答がありません");
    });

    it("caps the buffer to 50 entries, dropping the oldest first", () => {
        const append = useSessionStore.getState().appendApprovalNotice;
        for (let i = 0; i < 55; i += 1) {
            append({ summary: `s${i}`, kind: "commandExecution", detail: `d${i}` });
        }
        const notices = useSessionStore.getState().approvalNotices;
        expect(notices).toHaveLength(50);
        // Oldest five (s0..s4) should be dropped; the newest 50 (s5..s54) remain.
        expect(notices[0]?.summary).toBe("s5");
        expect(notices.at(-1)?.summary).toBe("s54");
    });
});
