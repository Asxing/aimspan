import { redact } from "./security.js";

export const MAX_AGENT_MESSAGE_CHARS = 20_000;

/** Carry the cap through parsing and storage, including an exact-length reply. */
export function boundedAgentMessage(body: string, wasTruncated = false): { lastAgentMessage: string; lastAgentMessageTruncated: boolean } {
    const safe = redact(body, MAX_AGENT_MESSAGE_CHARS + 1);
    return { lastAgentMessage: safe.slice(0, MAX_AGENT_MESSAGE_CHARS), lastAgentMessageTruncated: wasTruncated || safe.length > MAX_AGENT_MESSAGE_CHARS };
}

/** Bounded, redacted facts shared by native source adapters. */
export interface SourceTurn {
    turnId?: string | undefined;
    promptAt: string;
    endedAt?: string | undefined;
    aborted?: boolean | undefined;
    /** Inclusive fact boundary when a read gap follows this turn. */
    factsThrough?: string | undefined;
    durationMs?: number;
    lastAgentMessage?: string | undefined;
    lastAgentMessageTruncated?: boolean | undefined;
    errors: string[];
    changedFiles: string[];
    failedCommands: string[];
    awaySummary?: string | undefined;
}
