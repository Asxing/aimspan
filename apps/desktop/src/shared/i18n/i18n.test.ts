import { expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "@aimspan/protocol";
import { en } from "./en";
import { zhCN } from "./zh-CN";
import { t, translator } from "./index";
import { errorMessage } from "./errors";

test("catalogs have exactly the same keys, signatures and nonempty messages", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(typeof zhCN[key]).toBe(typeof en[key]);
        for (const catalog of [en, zhCN]) {
            const value = catalog[key];
            for (const n of [0, 1, 2]) {
                const text = typeof value === "function" ? Reflect.apply(value, null, [n, n, n]) : value;
                expect(text.trim(), key).not.toBe("");
                expect(text, key).not.toContain("undefined");
            }
        }
    }
    expect(DEFAULT_SETTINGS.language).toBe("en");
    expect(t("zh-CN", "settings")).toBe(t("zh", "settings"));
    // @ts-expect-error Unknown catalog keys must fail at compile time.
    if (false) t("en", "missing.key");
    // @ts-expect-error Count messages require a count.
    if (false) t("en", "ideaCount");
});

test("English counts use singular and plural; native language labels remain fixed", () => {
    expect(t("en", "ideaCount", 1)).toBe("1 idea");
    expect(t("en", "ideaCount", 2)).toBe("2 ideas");
    expect(t("en", "processSteps", 1)).toBe("Process · 1 step");
    expect(t("en", "processSteps", 5)).toBe("Process · 5 steps");
    expect(t("en", "notificationIdeas", 1)).toBe(" · You saved 1 idea");
    expect(t("zh", "chineseOption")).toBe("中文");
    expect(t("en", "englishOption")).toBe("English");
});

test("native messages resolve current preferences and errors translate IPC codes in both languages", () => {
    let language: "en" | "zh" = "en";
    const translate = translator(() => language);
    expect(translate("settings")).toBe("Settings");
    language = "zh";
    expect(translate("settings")).toBe("设置");
    const error = new Error("Error invoking remote method 'companion:call': Error: core.errorRecordChangedReloadBeforeSaving");
    expect(errorMessage(error, "en")).toBe("Record changed; reload before saving");
    expect(errorMessage(error, "zh")).toBe("记录已变化，请重新读取后保存");
    expect(errorMessage(new Error("CAPTURE_STALE_OPEN"), "zh")).toBe("快捷记录已重新打开，请确认目标后再保存");
    expect(errorMessage(new Error("unrecognized internal failure"))).toBe("Operation failed. Saved records are preserved");
});
