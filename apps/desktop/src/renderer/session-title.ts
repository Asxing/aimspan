import { translator, type Language } from "../shared/i18n";
/** Presentation only: source identity and stored titles remain untouched. */
export function sessionTitle(session: { id: string; nativeId: string; title: string }, language: Language = "en"): string {
    const t = translator(language);
    const title = session.title.trim();
    return !title || title === session.id || title === session.nativeId ||
        // Source titles have a 120-character read limit, including ID fallbacks.
        title === session.nativeId.slice(0, 120)
        ? t("untitledSession") : session.title;
}
