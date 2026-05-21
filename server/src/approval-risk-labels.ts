/**
 * Structural signs detected by `analyzeCommand`. These describe shell syntax
 * features only, not verb-dictionary risk labels.
 */
export type StructuralSignal =
    | "shell-wrapper"
    | "command-substitution"
    | "variable-expansion"
    | "wildcard-expansion"
    | "quoted-token"
    | "redirect"
    | "find-exec"
    | "truncated"
    | "overflowed";

/**
 * Verb-derived labels attached by `detectRiskLabels` from critical command
 * patterns in later phases.
 */
export type VerbRiskLabel =
    | "file-delete"
    | "device-write"
    | "filesystem-format"
    | "git-reset-hard"
    | "git-clean-force"
    | "permission-change"
    | "shutdown-reboot"
    | "fork-bomb"
    | "privileged"
    | "git-push"
    | "network-fetch"
    | "remote-shell";

/** Union element type for the `riskLabels` array exposed to approval callers. */
export type RiskLabel = StructuralSignal | VerbRiskLabel;

/**
 * Verb labels that route `commandExecRisky` to the destructive-action approval
 * wording.
 */
export const DESTRUCTIVE_VERBS: ReadonlySet<VerbRiskLabel> = new Set([
    "file-delete",
    "device-write",
    "filesystem-format",
    "git-reset-hard",
    "git-clean-force",
    "permission-change",
    "shutdown-reboot",
    "fork-bomb",
]);

/**
 * Verb labels that route `commandExecRisky` to the security-sensitive approval
 * wording.
 */
export const SECURITY_SENSITIVE_VERBS: ReadonlySet<VerbRiskLabel> = new Set([
    "privileged",
    "git-push",
    "network-fetch",
    "remote-shell",
]);
