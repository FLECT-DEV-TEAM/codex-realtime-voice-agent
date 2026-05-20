import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { enMessages, type MessageCatalog, type MessageKey } from "./en.js";
import { jaMessages } from "./ja.js";
import { useUiStore, type UiLocale } from "../state/ui-store.js";

type InterpolationParams = Record<string, string | number>;
type TFunction = (key: MessageKey, params?: InterpolationParams) => string;
type LooseLocOrText =
    | { text: string }
    | { loc: { key: string; params?: Record<string, string | number> } };

const dictionaries: Record<UiLocale, MessageCatalog> = {
    en: enMessages,
    ja: jaMessages,
};

const I18nContext = createContext<{ uiLocale: UiLocale; t: TFunction } | null>(null);

export function interpolate(template: string, params?: InterpolationParams): string {
    if (!params) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
        const value = params[name];
        return value === undefined ? match : String(value);
    });
}

export function createTranslator(uiLocale: UiLocale): TFunction {
    return (key, params) => interpolate(dictionaries[uiLocale][key], params);
}

export function renderLoc(uiLocale: UiLocale, locOrText: LooseLocOrText): string {
    if ("text" in locOrText) return locOrText.text;

    const { key, params } = locOrText.loc;
    const messages = dictionaries[uiLocale];
    if (Object.prototype.hasOwnProperty.call(messages, key)) {
        return interpolate(messages[key as MessageKey], params);
    }

    console.warn(`Unknown i18n key: ${key}`);
    return `[missing:${key}]`;
}

export const I18nProvider = ({ children }: { children: ReactNode }) => {
    const uiLocale = useUiStore((s) => s.uiLocale);
    const value = useMemo(
        () => ({
            uiLocale,
            t: createTranslator(uiLocale),
        }),
        [uiLocale],
    );

    useEffect(() => {
        document.documentElement.lang = uiLocale;
    }, [uiLocale]);

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useT(): TFunction {
    const context = useContext(I18nContext);
    if (!context) throw new Error("useT must be used inside I18nProvider");
    return context.t;
}

export function useUiLocale(): UiLocale {
    const context = useContext(I18nContext);
    if (!context) throw new Error("useUiLocale must be used inside I18nProvider");
    return context.uiLocale;
}

export { enMessages, jaMessages };
export type { MessageKey };
