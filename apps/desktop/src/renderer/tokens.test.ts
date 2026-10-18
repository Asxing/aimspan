// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DIAMETER } from "../main/bubble-geometry";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const blocks = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
const colors = (block: string) => Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[\da-f]+);/gi)].map(([, name, value]) => [name!, value!]));
const light = colors(blocks[0]![1]!);
const dark = { ...light, ...colors(blocks[1]![1]!) };
type RGB = [number, number, number];
function rgb(hex: string): RGB {
    if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex)) throw new Error(`Expected a measurable hex token: ${hex}`);
    return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255) as RGB;
}
function composite(hex: string, background: RGB): RGB {
    const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
    return rgb(hex).map((value, i) => alpha * value + (1 - alpha) * background[i]!) as RGB;
}
function luminance(color: RGB): number {
    const linear = color.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function contrast(a: RGB, b: RGB): number {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test.each(["styles", "capture", "bubble", "compact"])("%s imports shared tokens and has no local palette", name => {
    const component = readFileSync(new URL(`./${name}.css`, import.meta.url), "utf8");
    expect(component).toMatch(/@import\s+"\.\/tokens.css"/);
    expect(component).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl|light-dark)\(/i);
});

test.each([["light", light], ["dark", dark]] as const)("%s text, actions and state markers meet contrast thresholds", (theme, palette) => {
    const backgrounds = Object.fromEntries(["surface", "elevated", "surface-2", "hover", "selected", "accent-soft", "danger-surface"].map(key => [key, rgb(palette[key]!)]));
    backgrounds["capture on black"] = composite(palette["capture-surface"]!, [0, 0, 0]);
    backgrounds["capture on white"] = composite(palette["capture-surface"]!, [1, 1, 1]);
    for (const [name, background] of Object.entries(backgrounds)) {
        for (const [token, minimum] of [["text", 4.5], ["secondary", 4.5], ["action-text", 4.5], ["waiting", 4.5], ["running", 4.5], ["danger", 4.5], ["waiting-dot", 3], ["idle-ring", 3], ["focus", 3]] as const) {
            const ratio = contrast(rgb(palette[token]!), background);
            expect(ratio, `${theme} ${token} on ${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
        }
    }
    for (const background of ["accent", "accent-hover"]) {
        expect(contrast(rgb(palette["on-accent"]!), rgb(palette[background]!)), `${theme} primary action on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(rgb(palette.danger!), rgb(palette["danger-surface"]!)), `${theme} error text`).toBeGreaterThanOrEqual(4.5);
});

test("T22 expanded cards use a soft token shadow and keyboard-only row focus; reply clamp is eight lines", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.session\.expanded\{box-shadow:var\(--shadow-card\)\}/);
    expect(styles).not.toMatch(/(?:^|\n)\.keyboard-selected\{/);
    expect(styles).toMatch(/\.list-region:focus-visible \.keyboard-selected:not\(\.expanded\)\{outline:/);
    expect(styles).toMatch(/\.reply-body\{[^}]*line-height:1\.5\}/);
    expect(styles).toMatch(/\.reply-clamped\{max-height:12em;/);
});

test("T22 bubble numbers stack inside the visible half, and both breathing indicators respect reduced motion", () => {
    const bubble = readFileSync(new URL("./bubble.css", import.meta.url), "utf8");
    const markers = readFileSync(new URL("./session-state.css", import.meta.url), "utf8");
    expect(bubble).toContain(`width: ${DIAMETER}px; height: ${DIAMETER}px;`);
    expect(bubble).toMatch(/\.bubble-counts \{[^}]*flex-direction: column;[^}]*justify-content: center;/);
    expect(bubble).toMatch(/\[data-side=right\] \.bubble-counts \{ right: 28px; left: 1px;/);
    expect(bubble).toMatch(/\[data-side=left\] \.bubble-counts \{ left: 28px; right: 1px;/);
    expect(bubble).toMatch(/prefers-reduced-motion: reduce[^\n]*\.bubble-ring\.running \{ animation: none;/);
    expect(markers).toMatch(/prefers-reduced-motion: reduce[^\n]*\.state-marker\.running \{ animation: none;/);
});
