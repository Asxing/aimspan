import { createContext, useContext, useEffect } from "react";
import { htmlLanguage, translator, type Language } from "./index";

export const LanguageContext = createContext<Language>("en");
export function useI18n(override?: Language, title?: "appTitle" | "captureTitle" | "bubbleTitle" | "compactTitle") {
    const inherited = useContext(LanguageContext);
    const language = override ?? inherited;
    const t = translator(language);
    useEffect(() => {
        if (title) {
            document.documentElement.lang = htmlLanguage(language);
            document.title = t(title);
        }
    }, [language, title]);
    return { language, t };
}
