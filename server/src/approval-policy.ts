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
import {
    analyzeCommand,
    capLine,
    extractCommandTokens,
    redact,
    type CommandAnalysis,
} from "./approval-sanitize.js";
import {
    DESTRUCTIVE_VERBS,
    SECURITY_SENSITIVE_VERBS,
    type RiskLabel,
    type StructuralSignal,
    type VerbRiskLabel,
} from "./approval-risk-labels.js";

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

const CRITICAL_PATTERNS_MAP: ReadonlyMap<RegExp, VerbRiskLabel> = new Map([
    [/\brm\s/, "file-delete"],
    [/\brmdir\b/, "file-delete"],
    [/\bshutdown\b/, "shutdown-reboot"],
    [/\breboot\b/, "shutdown-reboot"],
    [/\bmkfs\b/, "filesystem-format"],
    [/\bdd\s/, "device-write"],
    [/:\(\)\{:\|:&\};:/, "fork-bomb"],
    [/\bgit\s+push\b/, "git-push"],
    [/\bgit\s+reset\s+--hard\b/, "git-reset-hard"],
    [/\bgit\s+clean\s+-f\b/, "git-clean-force"],
    [/\bcurl\s/, "network-fetch"],
    [/\bwget\s/, "network-fetch"],
    [/\bscp\s/, "network-fetch"],
    [/\brsync\s/, "remote-shell"],
    [/\bssh\s/, "remote-shell"],
    [/\bsudo\b/, "privileged"],
    [/\bchmod\s+777\b/, "permission-change"],
    [/\bchown\b/, "permission-change"],
]);

const STRUCTURAL_CRITICAL_SIGNALS: ReadonlySet<StructuralSignal> = new Set([
    "shell-wrapper",
    "command-substitution",
    "find-exec",
]);

const STRUCTURAL_BLOCK_LLM_DETAIL: ReadonlySet<StructuralSignal> = new Set([
    "truncated",
    "overflowed",
    "redirect",
    "variable-expansion",
]);

const PROHIBITED_TOKENS = [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $",
    "mkfs.",
    ":(){:|:&};:",
    "/etc/passwd",
    "/etc/shadow",
];

export const detectRiskLabels = (
    command: string | string[] | undefined,
    analysis: CommandAnalysis,
): {
    riskLabels: RiskLabel[];
    matchedCriticalPatterns: string[];
    structuralSignals: StructuralSignal[];
    auxiliarySignals: string[];
} => {
    const rawText =
        typeof command === "string"
            ? command
            : Array.isArray(command)
              ? command.filter((s): s is string => typeof s === "string").join(" ")
              : "";

    const matchedCriticalPatterns: string[] = [];
    const verbLabels: VerbRiskLabel[] = [];
    for (const [pattern, label] of CRITICAL_PATTERNS_MAP) {
        if (pattern.test(rawText)) {
            matchedCriticalPatterns.push(pattern.source);
            if (!verbLabels.includes(label)) verbLabels.push(label);
        }
    }

    const auxiliarySignals: string[] = [];
    if (/`[^`]*`/.test(rawText)) auxiliarySignals.push("command-substitution-backtick");

    const riskLabels: RiskLabel[] = [...analysis.structuralSignals, ...verbLabels];

    return {
        riskLabels,
        matchedCriticalPatterns,
        structuralSignals: analysis.structuralSignals,
        auxiliarySignals,
    };
};

const hasVerbLabel = (labels: readonly RiskLabel[], set: ReadonlySet<VerbRiskLabel>): boolean =>
    labels.some((label) => set.has(label as VerbRiskLabel));

export const isCritical = (labels: readonly RiskLabel[]): boolean => {
    if (hasVerbLabel(labels, DESTRUCTIVE_VERBS)) return true;
    if (hasVerbLabel(labels, SECURITY_SENSITIVE_VERBS)) return true;
    if (labels.some((label) => STRUCTURAL_CRITICAL_SIGNALS.has(label as StructuralSignal))) {
        return true;
    }
    if (
        labels.includes("wildcard-expansion") &&
        labels.some((label) => label === "file-delete" || label === "permission-change")
    ) {
        return true;
    }
    return false;
};

export const mustBlockLlmDetail = (labels: readonly RiskLabel[]): boolean => {
    if (isCritical(labels)) return true;
    return labels.some((label) => STRUCTURAL_BLOCK_LLM_DETAIL.has(label as StructuralSignal));
};

export const classifyApproval = (
    input: PolicyInput,
    strings: VoiceStrings,
): {
    verdict: PolicyVerdict;
    reason: string;
    /** Short summary of the requested action for TTS readout. */
    summary: string;
    riskLabels?: RiskLabel[];
    matchedCriticalPatterns?: string[];
    structuralSignals?: StructuralSignal[];
    auxiliarySignals?: string[];
    llmDetailBlocked?: boolean;
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
        const command = (input.params as { command?: unknown } | null | undefined)?.command;
        const analysis = analyzeCommand(command);
        const { riskLabels, matchedCriticalPatterns, structuralSignals, auxiliarySignals } =
            detectRiskLabels(command as string | string[] | undefined, analysis);
        const llmDetailBlocked = mustBlockLlmDetail(riskLabels);

        for (const [pattern] of CRITICAL_PATTERNS_MAP) {
            if (pattern.test(haystack)) {
                return {
                    verdict: "escalate",
                    reason: `critical pattern ${pattern.source}`,
                    summary,
                    riskLabels,
                    matchedCriticalPatterns,
                    structuralSignals,
                    auxiliarySignals,
                    llmDetailBlocked,
                };
            }
        }

        const verdictSignals = structuralSignals.filter(
            (signal) => signal !== "variable-expansion",
        );
        if (isCritical(verdictSignals) || mustBlockLlmDetail(verdictSignals)) {
            return {
                verdict: "escalate",
                reason: `structural signal ${verdictSignals.join(",")}`,
                summary,
                riskLabels,
                matchedCriticalPatterns,
                structuralSignals,
                auxiliarySignals,
                llmDetailBlocked,
            };
        }

        return {
            verdict: "auto-accept",
            reason: "command is in routine set",
            summary,
            riskLabels,
            matchedCriticalPatterns,
            structuralSignals,
            auxiliarySignals,
            llmDetailBlocked,
        };
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

const SUMMARY_LIMIT = 200;

const summarize = (input: PolicyInput, strings: VoiceStrings): string => {
    // Defensive: an approval-requested payload with params=null / non-object
    // would otherwise crash the property reads below. Mirrors the same
    // defensive cast used by buildApprovalDisplayDetail.
    const p: { command?: unknown; humanReadable?: unknown; reason?: unknown } =
        input.params && typeof input.params === "object"
            ? (input.params as { command?: unknown; humanReadable?: unknown; reason?: unknown })
            : {};

    if (input.kind === "commandExecution") {
        const analysis = analyzeCommand(p.command);
        const { riskLabels } = detectRiskLabels(
            p.command as string | string[] | undefined,
            analysis,
        );

        if (isCritical(riskLabels)) {
            return capLine(strings.summarize.commandExecRisky(riskLabels), SUMMARY_LIMIT);
        }
        if (
            mustBlockLlmDetail(riskLabels) ||
            analysis.truncated ||
            analysis.overflowed ||
            analysis.tokens.length === 0
        ) {
            return capLine(strings.summarize.commandExecTruncated(), SUMMARY_LIMIT);
        }
    }

    if (typeof p.humanReadable === "string") {
        return capLine(strings.summarize.fallback(redact(p.humanReadable)), SUMMARY_LIMIT);
    }

    if (input.kind === "commandExecution") {
        // Decide what the audio LLM gets to see: the shape-controlled token
        // list from approval-sanitize, NOT the raw command. The voice path
        // never touches `p.command` directly anymore (spec §5.3, §7.3).
        const tokens = extractCommandTokens(p.command as string | string[] | undefined);
        return capLine(strings.summarize.commandExec(tokens), SUMMARY_LIMIT);
    }

    if (input.kind === "fileChange") {
        const paths = input.resolvedPaths ?? [];
        if (paths.length > 0) {
            return capLine(
                strings.summarize.fileChange(input.hasDelete ? "delete" : "modify", paths),
                SUMMARY_LIMIT,
            );
        }
        const reason = typeof p.reason === "string" ? `(${redact(p.reason)})` : "";
        return capLine(strings.summarize.fallback(reason), SUMMARY_LIMIT);
    }

    return capLine(strings.summarize.unknownKind(input.kind), SUMMARY_LIMIT);
};

const pathInWorkspace = (p: string, cwd: string): boolean => {
    if (p.startsWith("/")) return p.startsWith(cwd.endsWith("/") ? cwd : cwd + "/") || p === cwd;
    if (p.startsWith("..")) return false;
    return true;
};
