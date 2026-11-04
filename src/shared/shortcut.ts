/**
 * `ctx.shortcut` (overlays): parsing "Alt+Shift+M" / "Mod+K", matching key
 * events, first-wins across scripts, and the before/after-page listeners.
 * The bridge owns the page's listeners (keys pressed in the page) and each
 * overlay frame matches its own shortcuts while it has focus.
 */

export type ShortcutPriority = "before-page" | "after-page";

export interface Combo {
    /** `KeyboardEvent.key` (single characters lower-cased) */
    key: string;
    /** the US-layout `KeyboardEvent.code`, for letters, digits and punctuation */
    code?: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    /** canonical form: two shortcuts with the same `id` are the same keys */
    id: string;
}

export const isMacPlatform = (nav: { platform?: string; userAgent?: string } = globalThis.navigator ?? {}): boolean => /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent || "");

const NAMED: Record<string, string> = {
    esc: "Escape",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: " ",
    spacebar: " ",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    insert: "Insert",
    ins: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    plus: "+",
};
for (let i = 1; i <= 24; i++) NAMED[`f${i}`] = `F${i}`;

const PUNCT_CODES: Record<string, string> = {
    "/": "Slash",
    ",": "Comma",
    ".": "Period",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "-": "Minus",
    "=": "Equal",
    "`": "Backquote",
};

/** "Alt+Shift+M", "Mod+K" (Mod = Cmd on macOS, Ctrl elsewhere), "Mod++"; throws a TypeError when it isn't one */
export function parseShortcut(keys: string, mac = isMacPlatform()): Combo {
    const bad = (why: string) => new TypeError(`ctx.shortcut: "${keys}" ${why}`);
    if (typeof keys !== "string" || !keys.trim()) throw new TypeError("ctx.shortcut: the keys must be a string like \"Alt+Shift+M\" or \"Mod+K\"");
    const c: Combo = { key: "", ctrl: false, alt: false, shift: false, meta: false, id: "" };
    const parts = keys.trim().split(/\s*\+(?!$)\s*/);
    parts.forEach((raw, i) => {
        const p = raw.trim();
        const low = p.toLowerCase();
        if (i < parts.length - 1) {
            if (low === "mod") c[mac ? "meta" : "ctrl"] = true;
            else if (low === "ctrl" || low === "control") c.ctrl = true;
            else if (low === "alt" || low === "option" || low === "opt") c.alt = true;
            else if (low === "shift") c.shift = true;
            else if (low === "meta" || low === "cmd" || low === "command" || low === "super" || low === "win") c.meta = true;
            else throw bad(`has an unknown modifier "${p}" (use Mod, Ctrl, Alt, Shift or Meta)`);
            return;
        }
        if (!p) throw bad("has no key");
        if ([...p].length === 1) c.key = low;
        else if (NAMED[low]) c.key = NAMED[low];
        else throw bad(`has an unknown key "${p}"`);
    });
    if (/^[a-z]$/.test(c.key)) c.code = `Key${c.key.toUpperCase()}`;
    else if (/^[0-9]$/.test(c.key)) c.code = `Digit${c.key}`;
    else if (PUNCT_CODES[c.key]) c.code = PUNCT_CODES[c.key];
    c.id = `${c.ctrl ? "Ctrl+" : ""}${c.alt ? "Alt+" : ""}${c.shift ? "Shift+" : ""}${c.meta ? "Meta+" : ""}${c.key}`;
    return c;
}

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * Exact modifiers, and the key by `key`. Where `key` isn't a plain letter
 * or digit (Option on macOS, Shift on digits, non-Latin layouts) it falls
 * back to the key's position (`code`).
 */
export function matchesCombo(c: Combo, e: KeyLike): boolean {
    if (e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift || e.metaKey !== c.meta) return false;
    const key = typeof e.key === "string" && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === c.key) return true;
    return !!c.code && e.code === c.code && !/^[a-z0-9]$/.test(key ?? "");
}

const TEXTLESS_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"]);

/** typing goes there: shortcuts stay out of it */
export function isEditable(t: EventTarget | null | undefined): boolean {
    const el = t as HTMLElement | null;
    if (!el || typeof el.tagName !== "string") return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName.toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    return tag === "INPUT" && !TEXTLESS_INPUTS.has(((el as HTMLInputElement).type || "text").toLowerCase());
}

export interface ShortcutEntry {
    /** the script */
    s: string;
    id: string;
    keys: string;
    combo: Combo;
    priority: ShortcutPriority;
}

/**
 * The registered shortcuts. Keys belong to one script at a time: the first
 * by `rank` (the bridge: the scripts' list order), then the first to register.
 */
export class ShortcutRegistry {
    private list: ShortcutEntry[] = [];

    constructor(
        private readonly mac = isMacPlatform(),
        private readonly rank: (s: string) => number = () => 0
    ) {}

    /** register; `taken`: another script keeps these keys; `displaced`: this one took them from another script */
    add(s: string, id: string, keys: string, priority: ShortcutPriority): { entry: ShortcutEntry; taken?: string; displaced?: string } {
        this.remove(s, id);
        const combo = parseShortcut(keys, this.mac);
        const entry: ShortcutEntry = { s, id, keys, combo, priority: priority === "after-page" ? "after-page" : "before-page" };
        const before = this.owner(this.list.filter((x) => x.combo.id === combo.id));
        this.list.push(entry);
        const after = this.owner(this.list.filter((x) => x.combo.id === combo.id));
        return { entry, taken: after !== s ? after : undefined, displaced: after === s && before !== undefined && before !== s ? before : undefined };
    }

    remove(s: string, id: string): void {
        this.list = this.list.filter((x) => x.s !== s || x.id !== id);
    }

    removeScript(s: string): void {
        this.list = this.list.filter((x) => x.s !== s);
    }

    get size(): number {
        return this.list.length;
    }

    /** the entries `e` triggers: those of the script that owns these keys */
    find(e: KeyLike): ShortcutEntry[] {
        const hits = this.list.filter((x) => matchesCombo(x.combo, e));
        const s = this.owner(hits);
        return hits.filter((x) => x.s === s);
    }

    private owner(entries: ShortcutEntry[]): string | undefined {
        let best: ShortcutEntry | undefined;
        for (const x of entries) if (!best || this.rank(x.s) < this.rank(best.s)) best = x;
        return best?.s;
    }
}

/**
 * Listen for shortcuts in `win`: a capture listener (registered first, so
 * it runs before the page's) fires `before-page` matches and stops the
 * event; a bubble listener, moved to the end of the window's list on each
 * key, fires `after-page` matches unless the page prevented the default or
 * stopped the event. Untrusted (synthetic) events, IME composition and
 * keys typed into editable fields are ignored.
 */
export function watchShortcuts(win: Window, find: (e: KeyboardEvent) => ShortcutEntry[], fire: (hits: ShortcutEntry[], e: KeyboardEvent) => void, opts: { trusted?: (e: KeyboardEvent) => boolean } = {}): () => void {
    const trusted = opts.trusted ?? ((e: KeyboardEvent) => e.isTrusted);
    const usable = (e: KeyboardEvent) => trusted(e) && !e.isComposing && !isEditable(e.composedPath?.()[0] ?? e.target);
    const bubble = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return;
        const hits = find(e).filter((h) => h.priority === "after-page");
        if (!hits.length || !usable(e)) return;
        e.preventDefault();
        fire(hits, e);
    };
    const capture = (e: KeyboardEvent) => {
        const hits = find(e);
        if (!hits.length || !usable(e)) return;
        const now = hits.filter((h) => h.priority === "before-page");
        if (now.length) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return fire(now, e);
        }
        // after the page's own window listeners
        win.removeEventListener("keydown", bubble);
        win.addEventListener("keydown", bubble);
    };
    win.addEventListener("keydown", capture, true);
    win.addEventListener("keydown", bubble);
    return () => {
        win.removeEventListener("keydown", capture, true);
        win.removeEventListener("keydown", bubble);
    };
}
