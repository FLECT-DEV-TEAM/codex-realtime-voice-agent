/**
 * Pure handler for the `approval/notice` server message.
 *
 * Why a dedicated module: this is the only `App.tsx` onmessage branch that's
 * worth testing in isolation right now (sanitised detail wiring, object-arg
 * shape). The other branches (`audio/flush`, `error.fatal`, `transcript`, …)
 * have side effects beyond the store and stay inside `App.tsx`. Keeping the
 * extraction scoped to `approval/notice` keeps the handler tree small.
 *
 * Spec: tasks/feature-plans/2026-05-20-approval-detail-display.v6.draft.md §13
 *       Phase 1, §12.2 (must-3 + reject-2 from Codex v3 review).
 */

/** Shape of the incoming `approval/notice` wire message. Mirrors
 *  `ServerToClientMessage` in `client/src/types/messages.ts` — kept narrow
 *  here so the handler can be tested without dragging in the whole union. */
export interface ApprovalNoticeMessage {
    type: "approval/notice";
    summary: string;
    kind: string;
    detail?: string;
}

/** Dependencies injected by the host (App.tsx). The handler is otherwise
 *  pure: no side effects beyond calling these. */
export interface ApprovalNoticeDeps {
    appendApprovalNotice: (notice: { summary: string; kind: string; detail?: string }) => void;
}

/** Forward the `approval/notice` payload into the store. The handler never
 *  touches audio / error / fatal-stop paths — those stay in `App.tsx` so
 *  this extraction does not affect their behaviour. */
export const applyApprovalNotice = (msg: ApprovalNoticeMessage, deps: ApprovalNoticeDeps): void => {
    deps.appendApprovalNotice({
        summary: msg.summary,
        kind: msg.kind,
        detail: msg.detail,
    });
};
