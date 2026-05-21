/**
 * Sanitisation helpers for approval display / audio summary.
 *
 * The approval flow has two parallel paths that both need to scrub sensitive
 * content before it leaves the server boundary:
 *
 * - The display detail (`approval/notice.detail`) is shown verbatim in the
 *   client transcript. It must redact env-like secrets, escape control chars,
 *   keep paths recognisable, and cap length so a malicious or accidental long
 *   command cannot flood the UI.
 * - The audio summary is constructed from {@link extractCommandTokens} so the
 *   Realtime LLM only ever sees a short, decisively-shaped token list — not
 *   the raw command. The same redact/escape primitives apply.
 *
 * Every function here is a pure function so it can be exercised in
 * `approval-sanitize.test.ts` without spinning up a session.
 *
 * Spec: tasks/feature-plans/2026-05-20-approval-detail-display.v6.draft.md §7.5
 */
import path from "node:path";
import type { StructuralSignal } from "./approval-risk-labels.js";

/** Sentinel inserted in place of a redacted env-like value. */
const REDACTED = "<redacted>";

/**
 * Redact env-like assignments (`KEY=VALUE`). KEY is intentionally restricted to
 * UPPER_SNAKE_CASE (a-z is out of scope per OQ-2). VALUE supports double-quoted
 * and single-quoted forms with `\.` escape passthrough; bare tokens stop at the
 * next whitespace or `;`. A broken quote (no closing `"`) falls through to the
 * bare branch, which intentionally only masks up to the next whitespace — the
 * tail after the space remains visible. This is the documented partial-leak
 * allowance for malformed input (spec §7.5.2).
 */
const REDACT_PATTERN =
    /(^|[\s;])([A-Z_][A-Z0-9_]{1,63})=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;]+)/g;

/** Mask env-like assignments to `<redacted>`. Idempotent: a `<redacted>` value
 *  never re-matches because its first char is `<`, not the value-part regex. */
export const redact = (input: string): string =>
    input.replace(
        REDACT_PATTERN,
        (_match, prefix: string, key: string) => `${prefix}${key}=${REDACTED}`,
    );

/** Replace `\t` and `\r` with a single space; drop all other C0 / DEL control
 *  characters. `\n` is preserved so multi-line detail bodies can use it as a
 *  separator; line-scoped callers (displayPath / displayCommand) strip it
 *  themselves before output. */
export const escapeControl = (input: string): string => {
    let out = "";
    for (const ch of input) {
        const code = ch.charCodeAt(0);
        if (ch === "\t" || ch === "\r") {
            out += " ";
            continue;
        }
        if (ch === "\n") {
            out += ch;
            continue;
        }
        if (code <= 0x1f || code === 0x7f) continue;
        out += ch;
    }
    return out;
};

/** True iff `target` resolves to a path at or under `workspace`. Uses
 *  `path.relative` and explicitly rejects `..` prefixes / OS-absolute results
 *  (the latter covers Windows drive-letter divergence). */
export const isInsideWorkspace = (target: string, workspace: string): boolean => {
    const rel = path.relative(workspace, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Mid-string ellipsis. Returns `text` unchanged if it fits, otherwise keeps a
 *  prefix and suffix around `…`. Always returns at most `limit` characters. */
export const capLine = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    if (limit <= 1) return "…".slice(0, limit);
    const keep = limit - 1; // budget after `…`
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return tail === 0
        ? `${text.slice(0, head)}…`
        : `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
};

/** Document-level cap. If `text` exceeds {@link DOCUMENT_LIMIT}, truncate from
 *  the end and append a visible `[truncated]` marker so the consumer knows
 *  information is lost. Distinct from {@link capLine} on purpose: ellipsis
 *  means "value still readable", `[truncated]` means "data discarded". */
const DOCUMENT_LIMIT = 2000;
const TRUNCATED_TAG = "\n[truncated]";
export const capDocument = (text: string): string => {
    if (text.length <= DOCUMENT_LIMIT) return text;
    const budget = DOCUMENT_LIMIT - TRUNCATED_TAG.length;
    return `${text.slice(0, Math.max(0, budget))}${TRUNCATED_TAG}`;
};

const PATH_LIMIT = 256;
const COMMAND_LIMIT = 500;
const TOKEN_LIMIT = 60;
/** Adopted-token cap for {@link extractCommandTokens}. Five-element return is
 *  the documented max (4 adopted + 1 `…` sentinel). */
const MAX_ADOPTED_TOKENS = 4;
const TOKEN_SENTINEL = "…";

export interface CommandAnalysis {
    tokens: string[];
    structuralSignals: StructuralSignal[];
    truncated: boolean;
    overflowed: boolean;
}

/** Shorten `$HOME/...` to `~/...` for display. Returns the input unchanged if
 *  HOME is unset or absent from the path. */
const replaceHomePrefix = (absolute: string): string => {
    const home = process.env.HOME;
    if (!home) return absolute;
    if (absolute === home) return "~";
    const prefix = home.endsWith("/") ? home : `${home}/`;
    if (absolute.startsWith(prefix)) return `~/${absolute.slice(prefix.length)}`;
    return absolute;
};

/** Render a path for display in the approval detail body. Inside the workspace
 *  → relative (with `.` for the workspace root itself). Outside → absolute,
 *  collapsing the `$HOME` prefix when possible. All output is line-scoped
 *  (newlines stripped) and capped to {@link PATH_LIMIT}. */
export const displayPath = (target: string, workspace: string): string => {
    let rendered: string;
    if (isInsideWorkspace(target, workspace)) {
        const rel = path.relative(workspace, target);
        rendered = rel === "" ? "." : rel;
    } else {
        rendered = path.isAbsolute(target) ? replaceHomePrefix(target) : target;
    }
    rendered = escapeControl(rendered).replace(/\n/g, " ").trim();
    return capLine(rendered, PATH_LIMIT);
};

const ARRAY_QUOTE_NEEDED = /[\s"\\]|^$/;

/** Quote one array element for `displayCommand` output. The escape rules are
 *  the documented minimum (spec §7.5.5): `\` → `\\`, `"` → `\"`, wrap in
 *  double quotes. Not shell-safe in any strict sense — the goal is to disambiguate
 *  whitespace-bearing arguments, not to be copy-pasteable. */
const quoteArrayElement = (element: string): string => {
    if (!ARRAY_QUOTE_NEEDED.test(element)) return element;
    const escaped = element.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
};

/** Render a command for the detail body. String input is treated as a single
 *  line (no shell parsing); array input is rendered argv-style with the
 *  minimal-escape quoting described above. Always single-line, capped to
 *  {@link COMMAND_LIMIT}, with env-like values redacted. */
export const displayCommand = (cmd: string | string[]): string => {
    let joined: string;
    if (Array.isArray(cmd)) {
        joined = cmd
            .map((element) => quoteArrayElement(escapeControl(redact(element)).replace(/\n/g, " ")))
            .join(" ");
    } else {
        joined = escapeControl(redact(cmd)).replace(/\n/g, " ");
    }
    return capLine(joined, COMMAND_LIMIT);
};

/** Exact-match shell separators recognised by {@link extractCommandTokens}. A
 *  token equal to one of these terminates the summary slice; everything after
 *  it is dropped. Anything embedded in a larger token (`cmd;cmd2`, `out>file`)
 *  is intentionally not split — simple whitespace tokenisation only. */
const SEPARATOR_TOKENS = new Set<string>([
    "|",
    "||",
    "&",
    "&&",
    ";",
    ">",
    ">>",
    "<",
    "<<",
    "2>",
    "2>>",
    "&>",
    "<<<",
]);

const REDIRECT_TOKENS = new Set<string>([">", ">>", "<", "<<", "2>", "2>>", "&>", "<<<"]);
const SHELL_WRAPPER_NAMES = new Set(["bash", "sh", "zsh", "fish", "csh", "tcsh", "ksh", "xargs"]);
const SHELL_EXEC_FLAGS = new Set(["-c", "-lc", "-cl", "-ec", "-ce", "-euc", "-uec"]);
const ENV_ASSIGNMENT_PREFIX = /^[A-Z_][A-Z0-9_]*=/;

const addSignal = (signals: StructuralSignal[], signal: StructuralSignal): void => {
    if (!signals.includes(signal)) signals.push(signal);
};

const invalidCommandAnalysis = (): CommandAnalysis => ({
    tokens: [],
    structuralSignals: ["truncated"],
    truncated: true,
    overflowed: false,
});

const hasShellWrapper = (rawTokens: string[]): boolean => {
    const [first, ...rest] = rawTokens;
    if (!first) return false;
    const shell = path.basename(first);
    if (shell === "env") {
        if (rest.some((token) => ENV_ASSIGNMENT_PREFIX.test(token))) return true;
        return rest.some((token, idx) => {
            if (!token.startsWith("-")) return false;
            return rest
                .slice(idx + 1)
                .some((t) => !t.startsWith("-") && !ENV_ASSIGNMENT_PREFIX.test(t));
        });
    }
    return SHELL_WRAPPER_NAMES.has(shell) && rest.some((token) => SHELL_EXEC_FLAGS.has(token));
};

const hasFindExec = (rawTokens: string[]): boolean =>
    rawTokens.some((token) => token === "find" || path.basename(token) === "find") &&
    rawTokens.some((token) => token === "-exec" || token === "-execdir" || token === "-delete");

const unquotedTokenText = (token: string): string =>
    token.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");

const tokenHasWildcardExpansion = (token: string): boolean =>
    /[*?\[]/.test(unquotedTokenText(token));

const tokenHasRedirect = (token: string): boolean => {
    const stripped = token.replace(/<redacted>/g, "");
    if (REDIRECT_TOKENS.has(stripped)) return true;
    if (!stripped) return false;
    return /[12]?>>?|<<<|<<|&>/.test(stripped) && !REDIRECT_TOKENS.has(stripped);
};

const collectStructuralSignals = (
    rawTokens: string[],
    rawText: string,
    separatorTruncated: boolean,
    tokenCapped: boolean,
    overflowed: boolean,
): StructuralSignal[] => {
    const signals: StructuralSignal[] = [];

    if (hasShellWrapper(rawTokens)) addSignal(signals, "shell-wrapper");
    if (/\$\([^)]*\)|`[^`]*`/.test(rawText)) addSignal(signals, "command-substitution");
    if (/(^|[^\\])\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}\s]+\})/.test(rawText)) {
        addSignal(signals, "variable-expansion");
    }
    if (rawTokens.some(tokenHasWildcardExpansion)) addSignal(signals, "wildcard-expansion");
    if (/["']/.test(rawText)) addSignal(signals, "quoted-token");
    if (rawTokens.some(tokenHasRedirect)) addSignal(signals, "redirect");
    if (hasFindExec(rawTokens)) addSignal(signals, "find-exec");
    if (separatorTruncated || tokenCapped) addSignal(signals, "truncated");
    if (overflowed) addSignal(signals, "overflowed");

    return signals;
};

/**
 * Analyze a command for audio-safe summary tokens and structural risk signs.
 *
 * Token algorithm (spec §7.5.6):
 *  1. For a string input, apply {@link redact} to the *whole* command first,
 *     then split on whitespace. This is what keeps quote-bearing assignments
 *     like `TOKEN="abc def" rm x` from being torn apart at the inner space.
 *  2. For an array input, treat each element as a token verbatim (no splitting).
 *  3. Truncate at the first exact-match separator token.
 *  4. Per token: redact (idempotent), escape control chars, collapse internal
 *     whitespace, take the basename if the token contains `/`, cap to
 *     {@link TOKEN_LIMIT}.
 *  5. Keep at most {@link MAX_ADOPTED_TOKENS} adopted tokens; if the input had
 *     more, append a single `…` sentinel.
 *
 * The same pass also detects structural signs from the raw command text before
 * verb-dictionary logic is applied.
 */
export const analyzeCommand = (cmd: unknown): CommandAnalysis => {
    if (cmd === undefined || cmd === null) return invalidCommandAnalysis();
    if (Array.isArray(cmd) && !cmd.every((s) => typeof s === "string")) {
        return invalidCommandAnalysis();
    }

    const rawText = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : "";

    let raw: string[];
    if (Array.isArray(cmd)) {
        raw = cmd;
    } else if (typeof cmd === "string") {
        if (cmd.trim() === "") return invalidCommandAnalysis();
        const redactedWhole = redact(cmd);
        raw = redactedWhole.split(/\s+/).filter((t) => t.length > 0);
    } else {
        return invalidCommandAnalysis();
    }

    const sepIdx = raw.findIndex((t) => SEPARATOR_TOKENS.has(t));
    const separatorTruncated = sepIdx >= 0;
    if (separatorTruncated) raw = raw.slice(0, sepIdx);

    if (raw.length === 0) return invalidCommandAnalysis();

    let tokenCapped = false;
    const tokens = raw.map((token) => {
        const r = redact(token);
        const e = escapeControl(r).replace(/\s+/g, " ").trim();
        const reduced = e.includes("/") ? path.basename(e) : e;
        const capped = capLine(reduced, TOKEN_LIMIT);
        tokenCapped ||= capped !== reduced;
        return capped;
    });

    const overflowed = tokens.length > MAX_ADOPTED_TOKENS;
    const rawStructuralTokens = rawText.split(/\s+/).filter((t) => t.length > 0);
    const structuralSignals = collectStructuralSignals(
        rawStructuralTokens,
        rawText,
        separatorTruncated,
        tokenCapped,
        overflowed,
    );

    if (tokens.length > MAX_ADOPTED_TOKENS) {
        return {
            tokens: [...tokens.slice(0, MAX_ADOPTED_TOKENS), TOKEN_SENTINEL],
            structuralSignals,
            truncated: separatorTruncated || tokenCapped,
            overflowed,
        };
    }
    return {
        tokens,
        structuralSignals,
        truncated: separatorTruncated || tokenCapped,
        overflowed,
    };
};

/** Backwards-compatible token-only accessor for {@link analyzeCommand}. */
export const extractCommandTokens = (cmd: string | string[] | undefined | null): string[] =>
    analyzeCommand(cmd).tokens;
