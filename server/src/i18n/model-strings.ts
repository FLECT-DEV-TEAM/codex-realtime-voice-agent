import type { ConversationLanguage } from "./conversation-language.js";

export interface ModelStrings {
    turnAlreadyRunning: string;
    bridgeNotConnected: string;
    turnExitedBeforeCompleted: string;
    idleTimeout: string;
    idleTimeoutUserCancelled: string;
    rawError: (raw: string) => string;
}

const ja: ModelStrings = {
    turnAlreadyRunning: "前のターンがまだ実行中です",
    bridgeNotConnected: "Codex bridge に接続されていません",
    turnExitedBeforeCompleted: "ターン完了イベントの前に Codex ターンが終了しました",
    idleTimeout: "Codex ターンがアイドルタイムアウトしました",
    idleTimeoutUserCancelled: "ユーザーの確認により Codex ターンを中断しました",
    rawError: (raw) => `エラーが発生しました。raw: ${raw}`,
};

const en: ModelStrings = {
    turnAlreadyRunning: "The previous turn is still running.",
    bridgeNotConnected: "Codex bridge is not connected.",
    turnExitedBeforeCompleted: "The Codex turn exited before the turn-completed event.",
    idleTimeout: "The Codex turn hit the idle timeout.",
    idleTimeoutUserCancelled: "The Codex turn was interrupted after user confirmation.",
    rawError: (raw) => `An error occurred. raw: ${raw}`,
};

const auto: ModelStrings = {
    turnAlreadyRunning: "Previous turn is still running.",
    bridgeNotConnected: "Codex bridge is not connected.",
    turnExitedBeforeCompleted: "Codex turn exited before completion.",
    idleTimeout: "Codex turn idle timeout.",
    idleTimeoutUserCancelled: "Codex turn interrupted after user confirmation.",
    rawError: (raw) => `Error. raw: ${raw}`,
};

export function getModelStrings(lang: ConversationLanguage): ModelStrings {
    if (lang === "ja") return ja;
    if (lang === "en") return en;
    return auto;
}
