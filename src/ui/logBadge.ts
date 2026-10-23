/**
 * Panel counts: what the Log / Network views currently hold (like VS Code's
 * Problems count). They stay until the view is cleared; looking at a view
 * doesn't reset them. Each renders as up to two pills.
 */
export interface TabBadge {
    /** pill class → count, in display order */
    readonly counts: readonly (readonly [cls: string, n: number])[];
    readonly empty: boolean;
    readonly title: string;
    reset(): void;
}

const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;

/** Log view: errors / warnings in the log buffer. */
export class LogBadge implements TabBadge {
    errors = 0;
    warnings = 0;

    /** A log entry joined the buffer; other levels are ignored. */
    note(level: string): void {
        if (level === "error") this.errors++;
        else if (level === "warn") this.warnings++;
    }

    /** A log entry fell out of the buffer. */
    drop(level: string): void {
        if (level === "error") this.errors = Math.max(0, this.errors - 1);
        else if (level === "warn") this.warnings = Math.max(0, this.warnings - 1);
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
        return `${[this.errors && plural(this.errors, "error"), this.warnings && plural(this.warnings, "warning")].filter(Boolean).join(", ")} in the Log`;
    }
}

/** Network view: requests a script observed / modified, among the recorded rows. */
export class NetBadge implements TabBadge {
    modified = 0;
    tapped = 0;

    set(c: { modified: number; tapped: number }): void {
        this.modified = c.modified;
        this.tapped = c.tapped;
    }

    reset(): void {
        this.modified = this.tapped = 0;
    }

    get counts() {
        return [["modified", this.modified], ["tapped", this.tapped]] as const;
    }

    get empty(): boolean {
        return !this.modified && !this.tapped;
    }

    get title(): string {
        const parts = [this.modified && `${this.modified} modified`, this.tapped && `${this.tapped} observed`].filter(Boolean);
        return `${parts.join(", ")} in Network`;
    }
}

export function badgeCount(n: number): string {
    return n > 99 ? "99+" : String(n);
}
