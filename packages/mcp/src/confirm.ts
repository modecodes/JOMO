/**
 * Two-phase confirmation for state-changing tools.
 *
 * Call 1 (no token): the server prepares the action, produces a human-readable summary and a
 * one-time `confirmationToken`, and changes nothing. Call 2 (with the token): the action runs.
 * How the token reaches the user is the server's policy (see server.ts): with an elicitation-capable
 * client the server asks the user itself and the model never sees the token; with `JOMO_CONFIRM=token`
 * the token is handed to the model for hosts that prompt the user before every tool call.
 *
 * A token is bound to the tool and the exact arguments it was issued for, is single-use, and expires.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PolicyRequest } from "./policy.js";

export const CONFIRMATION_TTL_MS = 120_000;

interface Pending<T> {
  summary: string;
  payload: T;
  scope: string;
  expires: number;
}

export class ConfirmationRequiredError extends Error {
  readonly code = "CONFIRMATION_REQUIRED";
  constructor(readonly token: string, readonly summary: string, readonly request: PolicyRequest) {
    super(`Confirmation required:\n${summary}`);
    this.name = "ConfirmationRequiredError";
  }
}

/** Stable identity of one call: the tool and its arguments, without the token itself. */
export function scopeOf(tool: string, args: Record<string, unknown>): string {
  const { confirmationToken: _omit, ...rest } = args;
  const canonical = JSON.stringify(rest, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
  return `${tool}:${createHash("sha256").update(canonical).digest("base64url")}`;
}

export class Confirmations {
  private readonly pending = new Map<string, Pending<unknown>>();

  /** Register a prepared action for one tool call; returns the token. */
  prepare<T>(summary: string, payload: T, scope: string): string {
    this.sweep();
    const token = randomBytes(18).toString("base64url");
    this.pending.set(token, { summary, payload, scope, expires: Date.now() + CONFIRMATION_TTL_MS });
    return token;
  }

  /** Consume a token for the same tool and arguments it was issued for; throws otherwise. */
  consume<T>(token: string, scope: string): T {
    this.sweep();
    const entry = this.pending.get(token);
    if (!entry) throw new Error("Unknown or expired confirmationToken. Call the tool again without a token to get a fresh one.");
    this.pending.delete(token);
    if (entry.scope !== scope) throw new Error("This confirmationToken was issued for a different tool or different arguments, so it has been cancelled. Nothing was sent. Call again without a token.");
    return entry.payload as T;
  }

  /** Drop a token the user declined, so it cannot be used later. */
  cancel(token: string): void {
    this.pending.delete(token);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) if (entry.expires < now) this.pending.delete(token);
  }
}
