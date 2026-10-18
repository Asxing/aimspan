import type { KeyboardEvent } from "react";

export function isComposing(event: KeyboardEvent, composing: boolean): boolean {
    return composing || event.nativeEvent.isComposing || event.keyCode === 229;
}
export function isSaveEnter(event: KeyboardEvent, composing: boolean): boolean {
    return event.key === "Enter" && !event.shiftKey && !isComposing(event, composing);
}
