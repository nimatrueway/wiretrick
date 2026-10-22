/**
 * Tab badges: counts of things that happened while a tab was out of view
 * (like VS Code's Problems badge). Each renders as up to two pills.
 */
export interface TabBadge {
    /** pill class → count, in display order */
    readonly counts: readonly (readonly [cls: string, n: number])[];
    readonly empty: boolean;
    readonly title: string;
    reset(): void;
}

const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;

/** Log tab: unseen errors / warnings. */
export class LogBadge implements TabBadge {
    errors = 0;
    warnings = 0;

    /** Count a log entry the user hasn't seen; other levels are ignored. */
    note(level: string): void {
        if (level === "error") this.errors++;
        else if (level === "warn") this.warnings++;
    }

    reset(): void {
        this.errors = this.warnings = 0;
    }

    get counts() {
        return [["error", this.errors], ["warn", this.warnings]] as const;
    }

    get empty(): boolean {
        return !this.errors && !this.warnings;
    }

    get title(): string {
        return `${[this.errors && plural(this.errors, "error"), this.warnings && plural(this.warnings, "warning")].filter(Boolean).join(", ")} since you last looked at the Log`;
    }
}

type Touch = "tapped" | "modified";
const RANK = { none: 0, tapped: 1, modified: 2 } as const;
const MAX_KNOWN = 5000;

/**
 * Network tab: requests a script newly tapped / modified while the tab was out
 * of view. Each request counts once, in its latest category — one that
 * goes tapped → modified moves from the tapped pill to the modified pill.
 */
export class NetBadge implements TabBadge {
    /** last state per request, kept across resets so updates don't recount */
    private known = new Map<string, Touch>();
    /** requests that changed state since the last reset */
    private pending = new Map<string, Touch>();

    /** redirect hops (`id:rN`) are the same request */
    private static key(id: string): string {
        return id.replace(/:r\d+$/, "");
    }

    /** Record a request's current state; `unseen` = the Network tab is out of view. */
    note(id: string, state: "none" | Touch, unseen: boolean): void {
        if (state === "none") return;
        const key = NetBadge.key(id);
        if (RANK[state] <= RANK[this.known.get(key) ?? "none"]) return;
        this.known.delete(key);
        this.known.set(key, state);
        if (this.known.size > MAX_KNOWN) this.known.delete(this.known.keys().next().value!);
        if (unseen) this.pending.set(key, state);
    }

    /** requests dropped by the recorder (e.g. a script-only row folded into the real one) */
    forget(ids: string[]): void {
        for (const id of ids) {
            if (NetBadge.key(id) !== id) continue;
            this.known.delete(id);
            this.pending.delete(id);
        }
    }

    clearAll(): void {
        this.known.clear();
        this.pending.clear();
    }

    reset(): void {
        this.pending.clear();
    }

    get modified(): number {
        let n = 0;
        for (const s of this.pending.values()) if (s === "modified") n++;
        return n;
    }

    get tapped(): number {
        return this.pending.size - this.modified;
    }

    get counts() {
        return [["modified", this.modified], ["tapped", this.tapped]] as const;
    }

    get empty(): boolean {
        return this.pending.size === 0;
    }

    get title(): string {
        const parts = [this.modified && `${this.modified} modified`, this.tapped && `${this.tapped} tapped`].filter(Boolean);
        return `${parts.join(", ")} since you last looked at Network`;
    }
}

export function badgeCount(n: number): string {
    return n > 99 ? "99+" : String(n);
}
