/**
 * Build the human-readable detail body that ships with `approval/notice`.
 *
 * Why this lives in its own module (and not as a session method): the body
 * needs to be testable without the session lifecycle. Session injects the
 * label bundle and workspace, the builder stays a pure function — easy to
 * exercise from `approval-display-detail.test.ts` with a fake label set.
 *
 * Whitelisting rule (spec §5.2 / §7.5): only `commandExecution` and
 * `fileChange` open up the body beyond the kind line. Anything else
 * (`permissions`, `toolUserInput`, `mcpElicitation`, unknown) returns the
 * kind line alone — we deliberately do NOT dump raw params (v1 reject-1).
 */
import { capDocument, displayCommand, displayPath } from "./approval-sanitize.js";
import type { VoiceStrings } from "./i18n/voice-strings.js";

export interface BuildDisplayDetailArgs {
    kind: string;
    params: unknown;
    resolvedPaths?: string[];
    workspace: string;
    labels: VoiceStrings["approvalDetail"];
}

/** Maximum number of resolved paths to enumerate before collapsing the tail
 *  into a `… (+N)` summary line. The whole document is also capped by
 *  {@link capDocument}; this limit just keeps the list itself readable. */
const FILE_TARGETS_DISPLAY_CAP = 20;

export const buildApprovalDisplayDetail = (args: BuildDisplayDetailArgs): string => {
    const { kind, params, resolvedPaths, workspace, labels } = args;
    // Defensive cast (v4 should-2): a hostile or unexpected approval-requested
    // payload may arrive with params=null / non-object. Treat as empty.
    const p: Record<string, unknown> =
        params && typeof params === "object" ? (params as Record<string, unknown>) : {};

    const lines: string[] = [`${labels.kind}: ${kind}`];

    if (kind === "fileChange" && resolvedPaths && resolvedPaths.length > 0) {
        const shown = resolvedPaths.slice(0, FILE_TARGETS_DISPLAY_CAP);
        lines.push(
            `${labels.fileTargets}:`,
            ...shown.map((target) => displayPath(target, workspace)),
        );
        if (resolvedPaths.length > FILE_TARGETS_DISPLAY_CAP) {
            lines.push(`… (+${resolvedPaths.length - FILE_TARGETS_DISPLAY_CAP})`);
        }
        return capDocument(lines.join("\n"));
    }

    if (kind === "commandExecution") {
        const cmd = p.command;
        if (typeof cmd === "string" || Array.isArray(cmd)) {
            lines.push(`${labels.command}: ${displayCommand(cmd as string | string[])}`);
        }
        if (typeof p.cwd === "string") {
            lines.push(`${labels.cwd}: ${displayPath(p.cwd, workspace)}`);
        }
        return capDocument(lines.join("\n"));
    }

    // permissions / toolUserInput / mcpElicitation / unknown → kind only.
    return lines.join("\n");
};
