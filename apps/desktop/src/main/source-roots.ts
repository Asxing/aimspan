import { join } from "node:path";

/** Adapters discover registry, active and archived records beneath each agent home. */
export function resolveSourceRoots(home: string, environment: { AIMSPAN_CODEX_ROOT?: string; AIMSPAN_CLAUDE_ROOT?: string } = {}) {
    return {
        codex: environment.AIMSPAN_CODEX_ROOT ?? join(home, ".codex"),
        claude: environment.AIMSPAN_CLAUDE_ROOT ?? join(home, ".claude"),
    };
}
