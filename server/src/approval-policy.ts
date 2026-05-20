/**
 * Deterministic classifier for Codex approval requests.
 *
 * The agent should:
 *   - auto-accept routine workspace-local operations (no voice prompt)
 *   - voice-escalate destructive / out-of-workspace operations
 *   - auto-refuse outright dangerous operations
 *
 * Keep the rules narrow and explicit — "if in doubt, escalate" rather than
 * letting the LLM judge.
 *
 * --------------------------------------------------------------------------
 * PLATFORM NOTE: POSIX (Linux / macOS) only.
 *
 * The patterns below recognise Unix shell syntax. A native-Windows Codex
 * would slip its own destructive commands (`format c:`, `Remove-Item
 * -Recurse`, `del /s /q c:\\`, `bcdedit`, `diskpart`, `vssadmin delete`,
 * `cipher /w:c:`, `reg delete hklm\\system`, ...) through `auto-accept`.
 * Extend the token lists or branch on `process.platform === "win32"` if you
 * target a Windows-native Codex. Linux + WSL hosts are covered as-is.
 * --------------------------------------------------------------------------
 */
import type { ApprovalKind } from "codex-app-server-bridge";
import type { VoiceStrings } from "./i18n/voice-strings.js";

export type PolicyVerdict = "auto-accept" | "escalate" | "auto-refuse";

export interface PolicyInput {
    kind: ApprovalKind;
    method: string;
    params: unknown;
    cwd: string;
    /**
     * For `fileChange` kind: paths Codex announced through `item-started`
     * before requesting approval. `FileChangeRequestApprovalParams` itself
     * does NOT contain paths, so the orchestrator looks them up by `itemId`
     * and passes them here.
     */
    resolvedPaths?: string[];
    /** True iff at least one resolved change is a delete. */
    hasDelete?: boolean;
}

const CRITICAL_PATTERNS: RegExp[] = [
    /\brm\s/,
    /\brmdir\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bmkfs\b/,
    /\bdd\s/,
    /:\(\)\{:\|:&\};:/,
    /\bgit\s+push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-f\b/,
    /\bcurl\s/,
    /\bwget\s/,
    /\bscp\s/,
    /\brsync\s/,
    /\bssh\s/,
    /\bsudo\b/,
    /\bchmod\s+777\b/,
    /\bchown\b/,
];

const PROHIBITED_TOKENS = [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $",
    "mkfs.",
    ":(){:|:&};:",
    "/etc/passwd",
    "/etc/shadow",
];

export const classifyApproval = (
    input: PolicyInput,
    strings: VoiceStrings,
): {
    verdict: PolicyVerdict;
    reason: string;
    /** Short summary of the requested action for TTS readout. */
    summary: string;
} => {
    const summary = summarize(input, strings);
    const haystack = JSON.stringify(input.params ?? {}).toLowerCase();

    for (const token of PROHIBITED_TOKENS) {
        if (haystack.includes(token.toLowerCase())) {
            return { verdict: "auto-refuse", reason: `prohibited token "${token}"`, summary };
        }
    }

    if (
        input.kind === "permissions" ||
        input.kind === "toolUserInput" ||
        input.kind === "mcpElicitation"
    ) {
        return { verdict: "escalate", reason: `kind=${input.kind} requires user input`, summary };
    }

    if (input.kind === "commandExecution") {
        for (const pattern of CRITICAL_PATTERNS) {
            if (pattern.test(haystack)) {
                return {
                    verdict: "escalate",
                    reason: `critical pattern ${pattern.source}`,
                    summary,
                };
            }
        }
        return { verdict: "auto-accept", reason: "command is in routine set", summary };
    }

    if (input.kind === "fileChange") {
        const paths = input.resolvedPaths ?? [];
        if (input.hasDelete) {
            return { verdict: "escalate", reason: "file deletion requires confirmation", summary };
        }
        if (paths.length === 0) {
            return { verdict: "escalate", reason: "paths not resolved", summary };
        }
        const allInWorkspace = paths.every((p) => pathInWorkspace(p, input.cwd));
        if (!allInWorkspace) {
            return { verdict: "escalate", reason: "edit outside workspace", summary };
        }
        return { verdict: "auto-accept", reason: "workspace-local edit", summary };
    }

    return { verdict: "escalate", reason: "unknown kind", summary };
};

const summarize = (input: PolicyInput, strings: VoiceStrings): string => {
    const p = input.params as { command?: unknown; humanReadable?: unknown; reason?: unknown };
    if (typeof p?.humanReadable === "string") {
        return strings.summarize.fallback(p.humanReadable).slice(0, 200);
    }
    if (input.kind === "commandExecution") {
        const cmd = p?.command;
        if (typeof cmd === "string") return strings.summarize.commandExec(cmd).slice(0, 200);
        if (Array.isArray(cmd)) {
            return strings.summarize.commandExec(cmd.join(" ")).slice(0, 200);
        }
    }
    if (input.kind === "fileChange") {
        const paths = input.resolvedPaths ?? [];
        if (paths.length > 0) {
            return strings.summarize
                .fileChange(input.hasDelete ? "delete" : "modify", paths)
                .slice(0, 200);
        }
        const reason = typeof p?.reason === "string" ? `(${p.reason})` : "";
        return strings.summarize.fallback(reason).slice(0, 200);
    }
    return strings.summarize.unknownKind(input.kind).slice(0, 200);
};

const pathInWorkspace = (p: string, cwd: string): boolean => {
    if (p.startsWith("/")) return p.startsWith(cwd.endsWith("/") ? cwd : cwd + "/") || p === cwd;
    if (p.startsWith("..")) return false;
    return true;
};
