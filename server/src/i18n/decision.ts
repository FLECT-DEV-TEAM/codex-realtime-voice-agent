import type { ConversationLanguage } from "./conversation-language.js";

export type ApprovalUtteranceDecision = "accept" | "refuse";

const SHORT_UTTERANCE_MAX = 20;

const normalizeCompact = (text: string): string =>
    text.replace(/[\s。、．，！？!?.'"`]/g, "").toLowerCase();

const normalizeLoose = (text: string): string =>
    text
        .trim()
        .toLowerCase()
        .replace(/[。．，！？!?.'"`]+$/g, "")
        .replace(/\s+/g, " ");

const hasWord = (text: string, word: string): boolean =>
    new RegExp(`(^|[^\\p{L}\\p{N}_])${word}([^\\p{L}\\p{N}_]|$)`, "iu").test(text);

const hasPhrase = (text: string, phrase: string): boolean =>
    new RegExp(
        `(^|[^\\p{L}\\p{N}_])${phrase.replace(/\s+/g, "\\s+")}([^\\p{L}\\p{N}_]|$)`,
        "iu",
    ).test(text);

const isShortClean = (text: string): boolean => {
    const compact = normalizeCompact(text);
    return compact.length > 0 && compact.length <= SHORT_UTTERANCE_MAX;
};

const isQuestionByJaEnRules = (text: string): boolean => {
    const raw = text.trim();
    if (/[?？]/.test(raw)) return true;
    if (/(でしょうか|かしら|かね|かな|か)[。.\s]*$/.test(raw)) return true;
    if (
        /(どれ|どの|どこ|なぜ|なに|何|いつ|だれ|誰|教えて|おしえて|詳しく|くわしく|具体的|フルパス|意味|理由|どういう|どうやって)/.test(
            raw,
        )
    ) {
        return true;
    }
    const lower = raw.toLowerCase();
    if (/\b(what|why|where|when|who|which|how)\b/.test(lower)) return true;
    return /^(can|could|would|will|is|are|should)\b/i.test(lower);
};

function classifyJa(text: string): ApprovalUtteranceDecision | null {
    const t = normalizeCompact(text);
    if (!t || t.length > SHORT_UTTERANCE_MAX) return null;

    const refuseTokens = [
        "大丈夫じゃない",
        "大丈夫ではない",
        "だいじょうぶじゃない",
        "だいじょうぶではない",
        "いいえ",
        "いえ",
        "いや",
        "ううん",
        "だめ",
        "ダメ",
        "駄目",
        "無理",
        "やめ",
        "止め",
        "やらないで",
        "しないで",
        "キャンセル",
        "きゃんせる",
        "ちがう",
        "違う",
        "結構です",
        "けっこうです",
    ];
    if (refuseTokens.some((token) => t.includes(token.toLowerCase()))) return "refuse";
    if (/(しない|しなくて|やらない|できない|しないで)$/.test(t)) return "refuse";
    // R-D5 is intentionally asymmetric: any broad Japanese negation reaches
    // refuse before accept tokens are considered. This can over-refuse safe
    // phrases such as "問題ない", "構わない", or "間違いない", but that only
    // falls back to re-confirmation; a false accept could execute an approval.
    if (/(ない|ません|なく|ぬ$|ず$)/.test(t)) return "refuse";

    const acceptTokens = [
        "はい",
        "ハイ",
        "うん",
        "ええ",
        "おっけ",
        "オッケ",
        "オーケー",
        "おーけー",
        "了解",
        "りょうかい",
        "いいよ",
        "お願い",
        "おねがい",
        "よろしく",
        "大丈夫",
        "だいじょうぶ",
        "進めて",
        "すすめて",
        "実行して",
        "続けて",
        "どうぞ",
    ];
    if (acceptTokens.some((token) => t.includes(token.toLowerCase()))) return "accept";
    return null;
}

function classifyEn(text: string): ApprovalUtteranceDecision | null {
    if (!isShortClean(text)) return null;
    const t = normalizeLoose(text);
    if (["cancel that", "do not", "don't"].some((phrase) => hasPhrase(t, phrase))) {
        return "refuse";
    }
    if (["no", "nope", "cancel", "stop", "dont"].some((word) => hasWord(t, word))) {
        return "refuse";
    }
    if (["go ahead", "do it"].some((phrase) => hasPhrase(t, phrase))) return "accept";
    if (["yes", "ok", "okay", "yeah", "yep", "sure"].some((word) => hasWord(t, word))) {
        return "accept";
    }
    return null;
}

const koAccept = ["네", "예", "응", "좋아", "좋아요", "해줘", "해주세요", "진행해", "진행해줘"];
const koRefuse = ["아니", "아니요", "아니오", "싫어", "하지마", "하지 마", "취소", "그만"];
const zhAccept = ["是", "好", "好的", "可以", "确定", "同意", "执行", "继续"];
const zhRefuse = ["不", "不要", "不行", "别", "取消", "拒绝", "停"];
const esAccept = ["sí", "si", "vale", "de acuerdo", "adelante", "hazlo"];
const esRefuse = ["no", "cancela", "para", "detente"];
const frAccept = ["oui", "d'accord", "vas-y", "fais-le"];
const frRefuse = ["non", "annule", "arrête", "arrete"];
const deAccept = ["ja", "okay", "mach", "mach es"];
const deRefuse = ["nein", "abbrechen", "stopp", "nicht", "halt"];

const normalizeEastAsian = (text: string): string =>
    normalizeLoose(text).replace(/(요|요\.|요。|요！|요!|입니다|です|ます)$/u, "");

function classifyMinimalAuto(text: string): ApprovalUtteranceDecision | null {
    const loose = normalizeLoose(text);
    const compact = normalizeCompact(text);
    const eastAsian = normalizeEastAsian(text);

    if (
        [...koRefuse, ...zhRefuse].some((token) => loose.includes(token) || compact.includes(token))
    ) {
        return "refuse";
    }
    if (
        [esRefuse, frRefuse, deRefuse].some((tokens) =>
            tokens.some((token) => hasWord(loose, token) || hasPhrase(loose, token)),
        )
    ) {
        return "refuse";
    }

    if (koAccept.some((token) => eastAsian === token)) return "accept";
    if (zhAccept.some((token) => eastAsian === token)) return "accept";

    if (!isShortClean(text)) return null;
    if (/[?？]/.test(text)) return null;
    for (const token of [...esAccept, ...frAccept, ...deAccept]) {
        if (loose === token && (hasWord(loose, token) || hasPhrase(loose, token))) return "accept";
    }
    return null;
}

export function isUserQuestion(text: string, _lang: ConversationLanguage): boolean {
    return isQuestionByJaEnRules(text);
}

export function classifyApprovalUtterance(
    text: string,
    lang: ConversationLanguage,
): ApprovalUtteranceDecision | null {
    if (isQuestionByJaEnRules(text)) return null;
    if (lang === "ja") return classifyJa(text);
    if (lang === "en") return classifyEn(text);
    return classifyJa(text) ?? classifyEn(text) ?? classifyMinimalAuto(text);
}
