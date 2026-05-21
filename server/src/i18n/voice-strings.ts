import path from "node:path";
import {
    DESTRUCTIVE_VERBS,
    SECURITY_SENSITIVE_VERBS,
    type RiskLabel,
    type VerbRiskLabel,
} from "../approval-risk-labels.js";
import {
    normalizeConversationLanguage,
    type ConversationLanguage,
} from "./conversation-language.js";

export interface ApprovalStepStrings {
    instructions: string;
    spokenInput: string;
}

export interface QuestionStepStrings {
    instructions: string;
    riskyInstructions: string;
    spokenInput: (summary: string) => string;
}

export interface ClarifyStepStrings {
    defaultQuestion: string;
    instructions: (question: string) => string;
    blockedDetailInstructions: string;
    blockedDetailResponse: string;
    spokenInput: (detail: string, question: string) => string;
}

export interface VoiceStrings {
    systemInstructions: {
        intro: string;
        rules: string[];
        codexProgressHeading: string;
        codexProgressExplanation: string;
    };
    approval: {
        notice: ApprovalStepStrings;
        question: QuestionStepStrings;
        clarify: ClarifyStepStrings;
        ambiguous: ApprovalStepStrings;
        outcome: {
            instructions: string;
            spokenInput: (spoken: string) => string;
        };
    };
    outcomes: {
        accepted: string;
        refused: string;
        refusedUnconfirmed: string;
        ambiguousReprompt: string;
    };
    summarize: {
        /** Audio summary for a commandExecution approval. `tokens` is the
         *  decisively-shaped output of `extractCommandTokens` (verb +
         *  basenamed args + optional sentinel), already sanitised. */
        commandExec: (tokens: string[]) => string;
        commandExecRisky: (labels: RiskLabel[]) => string;
        commandExecTruncated: () => string;
        fileChange: (kind: "delete" | "modify", paths: string[]) => string;
        fallback: (raw: string) => string;
        unknownKind: (kind: string) => string;
    };
    approvalDetail: {
        kind: string;
        fileTargets: string;
        command: string;
        cwd: string;
    };
    codexProgressPrefix: string;
    idleEscalation: (seconds: number) => string;
}

export function buildSystemInstructions(lang: ConversationLanguage): string {
    const strings = getVoiceStrings(lang);
    return `${strings.systemInstructions.intro}

## ${lang === "en" ? "Rules" : lang === "ja" ? "ルール" : "Rules"}
${strings.systemInstructions.rules.map((rule) => `- ${rule}`).join("\n")}

## ${strings.systemInstructions.codexProgressHeading} (${strings.codexProgressPrefix} ...)
${strings.systemInstructions.codexProgressExplanation}`;
}

const basenameList = (paths: string[]): string => paths.map((p) => path.basename(p)).join(", ");
const SUMMARY_LIMIT = 200;

type RiskRoute = "destructive" | "securitySensitive" | "structuralOnly";

const createRiskySummary = (
    riskLabelDictionary: Record<RiskLabel, string>,
    templates: Record<RiskRoute, (labels: string) => string>,
    emptySummary: string,
    separator: string,
): ((labels: RiskLabel[]) => string) => {
    const formatLabels = (labels: RiskLabel[], route: RiskRoute): string => {
        for (let count = labels.length; count >= 1; count -= 1) {
            const labelText = labels
                .slice(0, count)
                .map((label) => riskLabelDictionary[label])
                .join(separator);
            const suffix = count < labels.length ? "…" : "";
            const summary = templates[route](`${labelText}${suffix}`);
            if (summary.length <= SUMMARY_LIMIT) return summary;
        }
        return templates[route]("…").slice(0, SUMMARY_LIMIT);
    };

    return (labels) => {
        if (labels.length === 0) return emptySummary;
        const route = labels.some((label) => DESTRUCTIVE_VERBS.has(label as VerbRiskLabel))
            ? "destructive"
            : labels.some((label) => SECURITY_SENSITIVE_VERBS.has(label as VerbRiskLabel))
              ? "securitySensitive"
              : "structuralOnly";
        return formatLabels(labels, route);
    };
};

const jaStrings: VoiceStrings = {
    systemInstructions: {
        intro: "あなたは音声で操作できるコーディングアシスタントです。ユーザーから自然な日本語で依頼を受けたら、必要に応じて codex_turn 関数を呼び出して、Codex (別のサンドボックス化されたコーディングエージェント) に実装作業を委譲してください。",
        rules: [
            "ファイル操作、コード編集、コマンド実行、リポジトリ調査などコードに触れる作業は必ず codex_turn 経由で行うこと。",
            "codex_turn の結果テキストをそのままユーザーに音声で返さない。要点だけを短く伝える (10 秒以内に話せる分量)。",
            "自分自身はファイルを読んだり書いたりできない。Codex に任せること。",
            "雑談には簡潔に応じる。",
        ],
        codexProgressHeading: "Codex 進捗メッセージ",
        codexProgressExplanation:
            "会話中に `[Codex 進捗] ...` で始まるメッセージが流れてくることがあります。これは Codex の作業状況を共有する内部通知です。応答音声を生成する必要はありません。ユーザーが「進捗は?」と聞いたときの理解に活用してください。",
    },
    approval: {
        notice: {
            instructions:
                "あなたの唯一のタスクは、次の一文だけを自然な日本語で短く話して応答を終了することです。余計な説明・進捗報告・関数呼び出しは一切しないでください。",
            spokenInput:
                "「すみません、いま Codex から確認の依頼が来ました。内容をお伝えします。」とだけ短く言ってください。",
        },
        question: {
            instructions:
                "あなたの現在の唯一のタスクは、以下の承認依頼を「何をしようとしているのか」が伝わる自然な日本語で説明し、ユーザーに「はい」か「いいえ」で答えてもらうことです。\n\n読み上げ方の原則:\n- 生コマンドやフルパスは絶対に音声で読まない。\n- Codex が何をしようとしているのかを 1 文の日本語に要約する。技術用語は最小限に。\n- ファイル名は basename だけ言う。\n- 続けて「実行してもよろしいですか? はい か いいえ で答えてください。」と聞いて応答を終了する。\n\n直前までの会話の流れは無視してください。関数は呼ばないでください。読み上げ終わったら応答を終了してください。",
            riskyInstructions:
                "あなたの唯一のタスクは、以下の承認サマリを 1 字も変更せずそのまま読み上げ、応答を終了することです。関数は呼ばないでください。",
            spokenInput: (summary) =>
                `[システム通知] Codex から承認依頼が届きました。次の内容をユーザーに音声で確認してください。\n\n承認依頼の概要: ${summary}\n\n1 文の日本語で要約し、最後に「実行してもよろしいですか? はい か いいえ で答えてください。」と続けて応答を終えてください。`,
        },
        clarify: {
            defaultQuestion: "詳細を教えて",
            instructions: (question) =>
                `承認依頼の詳細データは次の通りです。ユーザーが「${question}」と質問しています。1 文で短く答えてください。答え終わったら「はい か いいえ で答えてください」と促してください。関数は呼ばないでください。`,
            blockedDetailInstructions:
                "次の一文だけを自然な日本語で短く話して応答を終了してください。余計な説明や関数呼び出しはしないでください。",
            blockedDetailResponse: "詳細は画面で確認してください。",
            spokenInput: (detail, question) =>
                `承認依頼の詳細データ:\n${detail}\n\nユーザーの質問:\n${question}\n\n1 文で短く答えてから、「はい か いいえ で答えてください」と促してください。`,
        },
        ambiguous: {
            instructions:
                "これ以上の説明・進捗報告はしないでください。「すみません、はい か いいえ でお願いします。」とだけ短く言って応答を終了してください。関数は呼ばないでください。",
            spokenInput: "もう一度、はい か いいえ で短く確認してください。",
        },
        outcome: {
            instructions:
                "次の一文だけを自然な日本語で短く話して応答を終了してください。余計な説明や関数呼び出しはしないでください。",
            spokenInput: (spoken) => `「${spoken}」とだけ短く言ってください。`,
        },
    },
    outcomes: {
        accepted: "承認しました。",
        refused: "却下しました。",
        refusedUnconfirmed: "確認できないため却下しました。",
        ambiguousReprompt: "すみません、はい か いいえ でお願いします。",
    },
    summarize: {
        // tokens は extractCommandTokens の戻り値 (verb + basename + 最大 5 要素)。
        // 空配列は extract できなかったときのフォールバックで、固定文を返す。
        commandExec: (tokens) =>
            tokens.length > 0
                ? `${tokens.join(" ")} の承認依頼です。`
                : "コマンド実行の承認依頼です。",
        commandExecRisky: createRiskySummary(
            {
                "file-delete": "ファイル削除",
                "device-write": "デバイス書き込み",
                "filesystem-format": "ファイルシステム初期化",
                "git-reset-hard": "git の強制リセット",
                "git-clean-force": "git の強制クリーン",
                "permission-change": "権限変更",
                "shutdown-reboot": "電源操作",
                "fork-bomb": "フォーク爆弾",
                privileged: "特権実行",
                "git-push": "git push",
                "network-fetch": "ネットワーク取得",
                "remote-shell": "リモート接続",
                "shell-wrapper": "シェル経由",
                "command-substitution": "コマンド置換",
                "variable-expansion": "変数展開",
                "wildcard-expansion": "ワイルドカード",
                "quoted-token": "引用符",
                redirect: "リダイレクト",
                "find-exec": "find -exec",
                truncated: "複数ステップ",
                overflowed: "トークン超過",
            },
            {
                destructive: (labels) =>
                    `破壊的な可能性があります (${labels})。画面で詳細を確認してから、はい か いいえ で答えてください。`,
                securitySensitive: (labels) =>
                    `注意が必要なコマンドです (${labels})。画面で詳細を確認してから、はい か いいえ で答えてください。`,
                structuralOnly: (labels) =>
                    `複雑な構造のコマンドです (${labels})。画面で詳細を確認してから、はい か いいえ で答えてください。`,
            },
            "コマンドの承認依頼です。",
            " / ",
        ),
        commandExecTruncated: () =>
            "複数ステップを含むコマンドの承認依頼です。詳細を画面で確認してから、はい か いいえ で答えてください。",
        fileChange: (kind, paths) =>
            kind === "delete"
                ? `ファイル削除の承認依頼です。対象: ${basenameList(paths)}`
                : `ファイル変更の承認依頼です。対象: ${basenameList(paths)}`,
        fallback: (raw) =>
            raw.trim() === ""
                ? "Codex が承認を求めています。"
                : `Codex が承認を求めています ${raw}。`,
        unknownKind: (kind) => `${kind} 承認リクエスト`,
    },
    approvalDetail: {
        kind: "種別",
        fileTargets: "ファイル変更対象",
        command: "コマンド",
        cwd: "作業ディレクトリ",
    },
    codexProgressPrefix: "[Codex 進捗]",
    idleEscalation: (seconds) => `Codex から ${seconds} 秒間応答がありません。中断しますか?`,
};

const enStrings: VoiceStrings = {
    systemInstructions: {
        intro: "You are a voice-operated coding assistant. When the user asks for coding work in natural English, call the codex_turn function as needed and delegate implementation to Codex, a separate sandboxed coding agent.",
        rules: [
            "Always use codex_turn for file operations, code edits, command execution, repository inspection, and any other work that touches code.",
            "Do not read the raw codex_turn result aloud. Give only the key points, brief enough to say in under 10 seconds.",
            "You cannot read or write files yourself. Delegate that work to Codex.",
            "Keep casual conversation concise.",
        ],
        codexProgressHeading: "Codex Progress Messages",
        codexProgressExplanation:
            "During the conversation you may receive messages beginning with `[Codex progress] ...`. These are internal status updates about Codex work. Do not generate speech for them. Use them only as context if the user asks for progress.",
    },
    approval: {
        notice: {
            instructions:
                "Your only task is to say exactly one short, natural English sentence and then stop. Do not add explanations, progress updates, or function calls.",
            spokenInput:
                'Say only: "Sorry, Codex needs your confirmation. I will explain the request now."',
        },
        question: {
            instructions:
                'Your only current task is to explain the approval request in natural English so the user understands what Codex wants to do, then ask for a yes or no answer.\n\nSpeaking rules:\n- Never read raw commands or full paths aloud.\n- Summarize what Codex is trying to do in one sentence. Keep technical terms minimal.\n- Mention only basenames for files.\n- End with: "May I let Codex proceed? Please answer yes or no."\n\nIgnore the previous conversation flow. Do not call functions. Stop after the question.',
            riskyInstructions:
                "Your only task is to read the following approval summary verbatim, then end the response. Do not call any functions.",
            spokenInput: (summary) =>
                `[System notice] Codex has requested approval. Please confirm this for the user by voice.\n\nApproval request summary: ${summary}\n\nSummarize it in one natural English sentence, then end with: "May I let Codex proceed? Please answer yes or no."`,
        },
        clarify: {
            defaultQuestion: "Please explain the details",
            instructions: (question) =>
                `The approval request details are below. The user asked: "${question}". Answer in one short sentence, then prompt them to answer yes or no. Do not call functions.`,
            blockedDetailInstructions:
                "Read the following single sentence in natural English, then end the response. Do not add explanations or call any functions.",
            blockedDetailResponse: "Please check the details on the screen.",
            spokenInput: (detail, question) =>
                `Approval request details:\n${detail}\n\nUser question:\n${question}\n\nAnswer in one short sentence, then ask them to answer yes or no.`,
        },
        ambiguous: {
            instructions:
                'Do not add any more explanation or progress update. Say only: "Sorry, please answer yes or no." Then stop. Do not call functions.',
            spokenInput: "Ask the user again, briefly, to answer yes or no.",
        },
        outcome: {
            instructions:
                "Say only the following short English sentence, then stop. Do not add explanations or call functions.",
            spokenInput: (spoken) => `Say only: "${spoken}"`,
        },
    },
    outcomes: {
        accepted: "Approved.",
        refused: "Declined.",
        refusedUnconfirmed: "Declined because I could not confirm.",
        ambiguousReprompt: "Sorry, please answer yes or no.",
    },
    summarize: {
        // tokens is the shape-controlled output of extractCommandTokens.
        // Empty array falls back to a generic line.
        commandExec: (tokens) =>
            tokens.length > 0
                ? `Codex is asking to run: ${tokens.join(" ")}.`
                : "Codex is asking to run a command.",
        commandExecRisky: createRiskySummary(
            {
                "file-delete": "file delete",
                "device-write": "device write",
                "filesystem-format": "filesystem format",
                "git-reset-hard": "git hard reset",
                "git-clean-force": "git clean -f",
                "permission-change": "permission change",
                "shutdown-reboot": "shutdown/reboot",
                "fork-bomb": "fork bomb",
                privileged: "privileged",
                "git-push": "git push",
                "network-fetch": "network fetch",
                "remote-shell": "remote shell",
                "shell-wrapper": "shell wrapper",
                "command-substitution": "command substitution",
                "variable-expansion": "variable expansion",
                "wildcard-expansion": "wildcards",
                "quoted-token": "quoted token",
                redirect: "redirect",
                "find-exec": "find -exec",
                truncated: "multi-step",
                overflowed: "overflow",
            },
            {
                destructive: (labels) =>
                    `This command may be destructive (${labels}). Please check the details on screen, then answer yes or no.`,
                securitySensitive: (labels) =>
                    `This command needs caution (${labels}). Please check the details on screen, then answer yes or no.`,
                structuralOnly: (labels) =>
                    `This command has a complex structure (${labels}). Please check the details on screen, then answer yes or no.`,
            },
            "This is a command approval request.",
            ", ",
        ),
        commandExecTruncated: () =>
            "This is a multi-step command approval request. Please check the details on screen, then answer yes or no.",
        fileChange: (kind, paths) =>
            kind === "delete"
                ? `Codex is asking to delete file(s): ${basenameList(paths)}`
                : `Codex is asking to modify file(s): ${basenameList(paths)}`,
        fallback: (raw) =>
            raw.trim() === ""
                ? "Codex is asking for approval."
                : `Codex is asking for approval ${raw}.`,
        unknownKind: (kind) => `${kind} approval request`,
    },
    approvalDetail: {
        kind: "Kind",
        fileTargets: "File change targets",
        command: "Command",
        cwd: "Working directory",
    },
    codexProgressPrefix: "[Codex progress]",
    idleEscalation: (seconds) =>
        `Codex has not responded for ${seconds} seconds. Do you want to stop it?`,
};

const autoStrings: VoiceStrings = {
    ...enStrings,
    systemInstructions: {
        ...enStrings.systemInstructions,
        intro: "You are a voice-operated coding assistant. Reply in the language the user is speaking. When the user asks for coding work, call the codex_turn function as needed and delegate implementation to Codex, a separate sandboxed coding agent.",
        rules: [
            "Reply in the language the user is speaking unless they explicitly ask otherwise.",
            "Always use codex_turn for file operations, code edits, command execution, repository inspection, and any other work that touches code.",
            "Do not read the raw codex_turn result aloud. Give only the key points, brief enough to say in under 10 seconds.",
            "You cannot read or write files yourself. Delegate that work to Codex.",
            "Keep casual conversation concise.",
        ],
    },
};

export function getVoiceStrings(lang: ConversationLanguage | string): VoiceStrings {
    const normalized = normalizeConversationLanguage(lang);
    if (normalized === "ja") return jaStrings;
    if (normalized === "en") return enStrings;
    return autoStrings;
}
