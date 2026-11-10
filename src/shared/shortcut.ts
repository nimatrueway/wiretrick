/**
 * `ctx.shortcut`: parsing "Alt+Shift+M" / "Mod+K", matching key events,
 * first-wins across scripts, and the before/after-page listeners. For
 * overlays the bridge owns the page's listeners (keys pressed in the page)
 * and each overlay frame matches its own shortcuts while it has focus;
 * onPage code listens in its own frame (`FrameShortcuts`).
 */

import { scriptLogLine } from "./scriptLog";

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

/** a shortcut param's value: keys `ctx.shortcut` takes, or "" for none */
export function isShortcut(v: unknown): v is string {
    if (v === "") return true;
    if (typeof v !== "string") return false;
    try {
        parseShortcut(v, false);
        return true;
    } catch {
        return false;
    }
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "OS", "Hyper", "Super", "CapsLock", "Fn", "FnLock"]);
const CODE_PUNCT: Record<string, string> = Object.fromEntries(Object.entries(PUNCT_CODES).map(([k, c]) => [c, k]));
const KEY_NAMES: Record<string, string> = { " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", "+": "Plus" };

/**
 * The keys a press makes, as a shortcut param stores them: "Mod+Shift+K"
 * (Mod for Cmd on macOS and Ctrl elsewhere, so it works on both). Letters,
 * digits and punctuation by position, so Shift, Option and the layout
 * don't change them. null while only modifiers are down.
 */
export function shortcutFromEvent(e: KeyLike, mac = isMacPlatform()): string | null {
    if (!e.key || MODIFIER_KEYS.has(e.key) || e.key === "Unidentified" || e.key === "Dead") return null;
    const code = e.code || "";
    let k = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : CODE_PUNCT[code] ?? (code === "Space" ? "Space" : KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key));
    if (k === "+") k = "Plus";
    const mods = [(mac ? e.metaKey : e.ctrlKey) && "Mod", mac && e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", !mac && e.metaKey && "Meta"].filter(Boolean);
    const keys = [...mods, k].join("+");
    try {
        parseShortcut(keys, mac);
        return keys;
    } catch {
        return null;
    }
}

const KEY_CAPS: Record<string, string> = { " ": "Space", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete" };

/** keycap labels for keys: ⌃ ⌥ ⇧ ⌘ K on macOS, Ctrl Alt Shift Meta K elsewhere; [] for "", [keys] when they aren't a shortcut */
export function formatShortcut(keys: string, mac = isMacPlatform()): string[] {
    if (!keys) return [];
    let c: Combo;
    try {
        c = parseShortcut(keys, mac);
    } catch {
        return [keys];
    }
    const key = KEY_CAPS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
    const mods = mac ? [c.ctrl && "⌃", c.alt && "⌥", c.shift && "⇧", c.meta && "⌘"] : [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta"];
    return [...(mods.filter(Boolean) as string[]), key];
}

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

/** what a `ctx.shortcut` function returns to leave the key to the page */
export const PASS = "pass";

/** run a shortcut's function; false when it returned "pass" (a throw or a promise consumes the key) */
export function runShortcut(fn: () => unknown, error: (e: unknown) => void): boolean {
    try {
        const out: any = fn();
        if (out && typeof out.then === "function") out.then(undefined, error);
        return out !== PASS;
    } catch (e) {
        error(e);
        return true;
    }
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
 * stopped the event. `fire` returns false when the key wasn't consumed
 * (the functions returned "pass"): the page gets it as if nothing matched.
 * Keys count everywhere, text fields included (they're hot keys); only
 * untrusted (synthetic) events are ignored.
 */
export function watchShortcuts(win: Window, find: (e: KeyboardEvent) => ShortcutEntry[], fire: (hits: ShortcutEntry[], e: KeyboardEvent) => boolean | void, opts: { trusted?: (e: KeyboardEvent) => boolean } = {}): () => void {
    const trusted = opts.trusted ?? ((e: KeyboardEvent) => e.isTrusted);
    const bubble = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return;
        const hits = find(e).filter((h) => h.priority === "after-page");
        if (!hits.length || !trusted(e)) return;
        if (fire(hits, e) !== false) e.preventDefault();
    };
    const capture = (e: KeyboardEvent) => {
        const hits = find(e);
        if (!hits.length || !trusted(e)) return;
        const now = hits.filter((h) => h.priority === "before-page");
        if (now.length && fire(now, e) !== false) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        if (now.length === hits.length) return;
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

/** check `ctx.shortcut`'s function and options; returns the priority */
export function shortcutPriority(fn: unknown, opts?: { priority?: ShortcutPriority }): ShortcutPriority {
    if (typeof fn !== "function") throw new TypeError("ctx.shortcut: the second argument must be a function");
    const priority = opts?.priority ?? "before-page";
    if (priority !== "before-page" && priority !== "after-page") throw new TypeError(`ctx.shortcut: priority must be "before-page" or "after-page"`);
    return priority;
}

/**
 * onPage's `ctx.shortcut`: keys pressed in this frame run the functions
 * here, in the world the handler runs in. Make it at document_start: its
 * capture listener must come before the page's. The scripts in this world
 * share keys by `rank` (list order).
 */
export class FrameShortcuts {
    private readonly reg: ShortcutRegistry;
    private readonly fns = new Map<string, () => unknown>();
    private ids = 0;
    private unwatch: (() => void) | null;

    constructor(
        win: Window,
        private readonly opts: {
            name: (s: string) => string;
            error: (s: string, e: unknown) => void;
            warn: (s: string, msg: string) => void;
            rank?: (s: string) => number;
            mac?: boolean;
            trusted?: (e: KeyboardEvent) => boolean;
        }
    ) {
        this.reg = new ShortcutRegistry(opts.mac ?? isMacPlatform(), opts.rank);
        this.unwatch = watchShortcuts(win, (e) => (this.reg.size ? this.reg.find(e) : []), (hits) => hits.map((h) => this.fire(h)).includes(true), { trusted: opts.trusted });
    }

    /** register for script `s` until the returned function runs or `signal` aborts */
    add(s: string, keys: string, fn: () => unknown, opts: { priority?: ShortcutPriority } | undefined, signal: AbortSignal): () => void {
        const priority = shortcutPriority(fn, opts);
        // a shortcut param the user cleared
        if (keys === "" || signal.aborted) return () => {};
        const id = String(++this.ids);
        const r = this.reg.add(s, id, keys, priority);
        this.fns.set(id, fn);
        const lost = (x: string) => this.opts.warn(x, scriptLogLine(this.opts.name(x), "onPage", `shortcut ${keys}: "${this.opts.name(r.taken ?? s)}" (earlier in the list) uses these keys too and keeps them`));
        if (r.taken) lost(s);
        if (r.displaced) lost(r.displaced);
        const off = () => {
            signal.removeEventListener("abort", off);
            if (!this.fns.delete(id)) return;
            this.reg.remove(s, id);
        };
        signal.addEventListener("abort", off, { once: true });
        return off;
    }

    removeScript(s: string): void {
        this.reg.removeScript(s);
    }

    stop(): void {
        this.unwatch?.();
        this.unwatch = null;
    }

    /** false: the function returned "pass" */
    private fire(h: ShortcutEntry): boolean {
        const fn = this.fns.get(h.id);
        return fn ? runShortcut(fn, (e) => this.opts.error(h.s, e)) : false;
    }
}
