import type { RunState } from "@aimspan/protocol";
import "./session-state.css";

export function StateMarker({ state }: { state: RunState }) {
    return <span className={`state-marker ${state}`} aria-hidden="true"/>;
}
