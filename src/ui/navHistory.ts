/**
 * VS Code-style Go Back / Go Forward: every jump records where it left
 * from; going back stores the current place for Go Forward.
 */
export class NavHistory<T> {
    private past: T[] = [];
    private future: T[] = [];

    constructor(private readonly max = 50) {}

    /** a jump away from `from`: remember it and drop the forward branch */
    push(from: T): void {
        this.past.push(from);
        if (this.past.length > this.max) this.past.shift();
        this.future = [];
    }

    /**
     * Step back from `current`. `open` goes to an entry: true = done,
     * false = cancelled (the entry stays), "skip" = gone (try the next one).
     */
    back(current: T, open: (to: T) => boolean | "skip"): boolean {
        return this.step(this.past, this.future, current, open);
    }

    forward(current: T, open: (to: T) => boolean | "skip"): boolean {
        return this.step(this.future, this.past, current, open);
    }

    get canGoBack(): boolean {
        return this.past.length > 0;
    }

    get canGoForward(): boolean {
        return this.future.length > 0;
    }

    private step(from: T[], to: T[], current: T, open: (to: T) => boolean | "skip"): boolean {
        while (from.length) {
            const target = from.pop()!;
            const r = open(target);
            if (r === "skip") continue;
            if (!r) {
                from.push(target);
                return false;
            }
            to.push(current);
            return true;
        }
        return false;
    }
}
