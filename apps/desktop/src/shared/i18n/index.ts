import type { Settings } from "@aimspan/protocol";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type Language = Settings["language"];
export type Locale = Language | "zh-CN";
export type MessageKey = keyof typeof en;
type Params<K extends MessageKey> = typeof en[K] extends (...args: infer P) => string ? P : [];
export function t<K extends MessageKey>(locale: Locale, key: K, ...params: Params<K>): string {
    const message = (locale === "en" ? en : zhCN)[key];
    return typeof message === "function" ? (message as unknown as (...args: Params<K>) => string)(...params) : message;
}
export function translator(locale: Locale | (() => Locale)) {
    return <K extends MessageKey>(key: K, ...params: Params<K>): string => t(typeof locale === "function" ? locale() : locale, key, ...params);
}
export const htmlLanguage = (language: Locale) => language === "en" ? "en" : "zh-CN";
