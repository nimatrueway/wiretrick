/** Unseen error/warning counts for the Log tab badge (like VS Code's Problems badge). */
export class LogBadge {
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

    get empty(): boolean {
        return !this.errors && !this.warnings;
    }

    get title(): string {
        const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
        return `${[this.errors && n(this.errors, "error"), this.warnings && n(this.warnings, "warning")].filter(Boolean).join(", ")} since you last looked at the Log`;
    }
}

export function badgeCount(n: number): string {
    return n > 99 ? "99+" : String(n);
}
