/**
 * Session health ledger — the shared contract between degradation detectors
 * and their consumers.
 *
 * Producers: inline request-path guards (prompt-size jump, duplicate device
 * routes, silent model switch), behavioral telemetry, the session-end
 * sentinel. Consumers: the status-line health segment (subscribes via
 * {@link HealthLedger#onChange}), `/doctor` style reports, and the session-end
 * summary notice.
 *
 * Design rules:
 * - Findings are append-only within a session; a rule may refresh its latest
 *   finding via `upsert` so repeated violations do not spam the ledger.
 * - Producers MUST be cheap and deterministic — no model calls, no I/O on the
 *   request path. Anything probabilistic belongs to offline doctor analysis.
 * - Consumers MUST tolerate an empty ledger; zero findings renders nothing.
 */

/** Severity of a health finding. `warn` findings surface in the status bar. */
export type HealthSeverity = "info" | "warn";

/** One detector observation. `rule` is a stable kebab-case id (e.g. "prompt-size-jump"). */
export interface HealthFinding {
	rule: string;
	severity: HealthSeverity;
	/** One-line human-readable message; rendered verbatim in notices and reports. */
	message: string;
	timestamp: number;
	/** Number of times this rule fired when producers use {@link HealthLedger#upsert}. */
	occurrences: number;
	/** Structured evidence for reports; never rendered in the status bar. */
	details?: Record<string, unknown>;
}

/** Input shape for recording a finding; bookkeeping fields are ledger-owned. */
export interface HealthFindingInput {
	rule: string;
	severity: HealthSeverity;
	message: string;
	details?: Record<string, unknown>;
}

/** Aggregate counts for compact rendering (status bar badge). */
export interface HealthCounts {
	info: number;
	warn: number;
}

/** Session-scoped, in-memory registry of health findings. */
export class HealthLedger {
	#findings: HealthFinding[] = [];
	#listeners = new Set<() => void>();
	#pendingNotices: string[] = [];

	/** All findings in insertion order. */
	findings(): readonly HealthFinding[] {
		return this.#findings;
	}

	/**
	 * Queue a user-facing notice for deferred delivery. Guards fire mid-turn or
	 * during startup, where an immediate transcript notice lands far from the
	 * user's viewport; the session drains this queue at the next turn boundary
	 * so notices appear beside the latest message.
	 */
	queueNotice(message: string): void {
		this.#pendingNotices.push(message);
	}

	/** Take all queued notices, leaving the queue empty. */
	drainNotices(): string[] {
		const drained = this.#pendingNotices;
		this.#pendingNotices = [];
		return drained;
	}

	/** Append a new finding unconditionally. */
	add(input: HealthFindingInput): HealthFinding {
		const finding: HealthFinding = { ...input, timestamp: Date.now(), occurrences: 1 };
		this.#findings.push(finding);
		this.#notify();
		return finding;
	}

	/**
	 * Record a violation of `rule`: refreshes the existing finding (message,
	 * details, timestamp, occurrence count) instead of appending a duplicate.
	 * Severity escalates but never de-escalates.
	 */
	upsert(input: HealthFindingInput): HealthFinding {
		const existing = this.#findings.find(f => f.rule === input.rule);
		if (!existing) return this.add(input);
		existing.message = input.message;
		existing.details = input.details;
		existing.timestamp = Date.now();
		existing.occurrences += 1;
		if (input.severity === "warn") existing.severity = "warn";
		this.#notify();
		return existing;
	}

	counts(): HealthCounts {
		let info = 0;
		let warn = 0;
		for (const f of this.#findings) {
			if (f.severity === "warn") warn += 1;
			else info += 1;
		}
		return { info, warn };
	}

	/** Subscribe to ledger changes; returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
