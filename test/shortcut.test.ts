// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { parseShortcut, matchesCombo, isEditable, ShortcutRegistry, watchShortcuts, shortcutFromEvent, formatShortcut, isShortcut, type KeyLike } from "../src/shared/shortcut";

const key = (k: string, code: string, mods: Partial<Pick<KeyLike, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {}): KeyLike => ({ key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe("parseShortcut", () => {
    it("parses modifiers in any case and order; Mod is Cmd on macOS, Ctrl elsewhere", () => {
        expect(parseShortcut("Alt+Shift+M", false)).toMatchObject({ key: "m", code: "KeyM", alt: true, shift: true, ctrl: false, meta: false, id: "Alt+Shift+m" });
        expect(parseShortcut("shift + alt + m", false).id).toBe("Alt+Shift+m");
        expect(parseShortcut("Mod+K", false)).toMatchObject({ ctrl: true, meta: false });
        expect(parseShortcut("Mod+K", true)).toMatchObject({ ctrl: false, meta: true });
        expect(parseShortcut("Cmd+Option+Control+1", true)).toMatchObject({ key: "1", code: "Digit1", meta: true, alt: true, ctrl: true });
    });

    it("parses named keys, punctuation and '+'", () => {
        expect(parseShortcut("Esc").key).toBe("Escape");
        expect(parseShortcut("Shift+F2").key).toBe("F2");
        expect(parseShortcut("Ctrl+Space").key).toBe(" ");
        expect(parseShortcut("Alt+Up").key).toBe("ArrowUp");
        expect(parseShortcut("Ctrl+/")).toMatchObject({ key: "/", code: "Slash" });
        expect(parseShortcut("Mod++", false)).toMatchObject({ key: "+", ctrl: true });
        expect(parseShortcut("Ctrl+Plus").key).toBe("+");
        expect(parseShortcut("+").key).toBe("+");
    });

    it("rejects what isn't a shortcut", () => {
        expect(() => parseShortcut("")).toThrow(TypeError);
        expect(() => parseShortcut(42 as any)).toThrow(TypeError);
        expect(() => parseShortcut("Hyper+K")).toThrow(/unknown modifier "Hyper"/);
        expect(() => parseShortcut("Alt+Kay")).toThrow(/unknown key "Kay"/);
        expect(() => parseShortcut("Alt+")).toThrow(TypeError);
    });
});

describe("matchesCombo", () => {
    it("needs exactly the combo's modifiers", () => {
        const c = parseShortcut("Alt+Shift+H", false);
        expect(matchesCombo(c, key("H", "KeyH", { altKey: true, shiftKey: true }))).toBe(true);
        expect(matchesCombo(c, key("H", "KeyH", { altKey: true, shiftKey: true, ctrlKey: true }))).toBe(false);
        expect(matchesCombo(c, key("h", "KeyH", { altKey: true }))).toBe(false);
    });

    it("matches the key position when the key isn't a plain letter or digit (Option on macOS, Shift+digit, other scripts)", () => {
        expect(matchesCombo(parseShortcut("Alt+L", true), key("¬", "KeyL", { altKey: true }))).toBe(true);
        expect(matchesCombo(parseShortcut("Alt+Shift+H", true), key("Ó", "KeyH", { altKey: true, shiftKey: true }))).toBe(true);
        expect(matchesCombo(parseShortcut("Shift+1"), key("!", "Digit1", { shiftKey: true }))).toBe(true);
        expect(matchesCombo(parseShortcut("Shift+/"), key("?", "Slash", { shiftKey: true }))).toBe(true);
        expect(matchesCombo(parseShortcut("Ctrl+K", false), key("л", "KeyK", { ctrlKey: true }))).toBe(true);
        // a layout's own letter wins over the position (AZERTY: the A key types "q")
        expect(matchesCombo(parseShortcut("Alt+A", false), key("q", "KeyA", { altKey: true }))).toBe(false);
        expect(matchesCombo(parseShortcut("Alt+Q", false), key("q", "KeyA", { altKey: true }))).toBe(true);
    });

    it("matches named keys by key", () => {
        expect(matchesCombo(parseShortcut("Esc"), key("Escape", "Escape"))).toBe(true);
        expect(matchesCombo(parseShortcut("Ctrl+Space", false), key(" ", "Space", { ctrlKey: true }))).toBe(true);
        expect(matchesCombo(parseShortcut("F2"), key("F3", "F3"))).toBe(false);
    });
});

describe("isEditable", () => {
    it("text fields and contenteditable are; buttons, checkboxes and plain elements aren't", () => {
        const el = (html: string) => {
            document.body.innerHTML = html;
            return document.body.firstElementChild;
        };
        expect(isEditable(el("<input>"))).toBe(true);
        expect(isEditable(el('<input type="search">'))).toBe(true);
        expect(isEditable(el("<textarea></textarea>"))).toBe(true);
        expect(isEditable(el("<select></select>"))).toBe(true);
        expect(isEditable(el('<div contenteditable="true"></div>'))).toBe(true);
        expect(isEditable(el('<input type="checkbox">'))).toBe(false);
        expect(isEditable(el("<button></button>"))).toBe(false);
        expect(isEditable(el("<div></div>"))).toBe(false);
        expect(isEditable(null)).toBe(false);
        expect(isEditable(window)).toBe(false);
    });
});

describe("ShortcutRegistry", () => {
    it("the first script to take some keys keeps them; the next takes over when it goes", () => {
        const r = new ShortcutRegistry(false);
        expect(r.add("a", "1", "Alt+K", "before-page").taken).toBeUndefined();
        expect(r.add("b", "1", "alt+k", "after-page").taken).toBe("a");
        expect(r.add("a", "2", "Alt+K", "before-page").taken).toBeUndefined();
        const ev = key("k", "KeyK", { altKey: true });
        expect(r.find(ev).map((h) => `${h.s}${h.id}`)).toEqual(["a1", "a2"]);
        r.removeScript("a");
        expect(r.find(ev).map((h) => `${h.s}${h.id}:${h.priority}`)).toEqual(["b1:after-page"]);
        r.remove("b", "1");
        expect(r.find(ev)).toEqual([]);
        expect(r.size).toBe(0);
    });

    it("a lower rank (the scripts' list order) beats registering first", () => {
        const order = ["a", "b"];
        const r = new ShortcutRegistry(false, (s) => order.indexOf(s));
        expect(r.add("b", "1", "Alt+K", "before-page")).toMatchObject({ taken: undefined, displaced: undefined });
        expect(r.add("a", "1", "Alt+K", "after-page")).toMatchObject({ taken: undefined, displaced: "b" });
        expect(r.find(key("k", "KeyK", { altKey: true })).map((h) => h.s)).toEqual(["a"]);
        expect(r.add("b", "2", "Alt+K", "before-page")).toMatchObject({ taken: "a" });
    });

    it("throws on bad keys and registers nothing", () => {
        const r = new ShortcutRegistry(false);
        expect(() => r.add("a", "1", "Nope+K", "before-page")).toThrow(TypeError);
        expect(r.size).toBe(0);
    });
});

describe("watchShortcuts", () => {
    let stops: (() => void)[] = [];
    afterEach(() => {
        for (const s of stops) s();
        stops = [];
        document.body.innerHTML = "";
    });

    function setup(priority: "before-page" | "after-page", trusted = true) {
        const r = new ShortcutRegistry(false);
        r.add("a", "1", "Alt+K", priority);
        const fired: string[] = [];
        stops.push(watchShortcuts(window, (e) => r.find(e), (hits) => fired.push(...hits.map((h) => h.id)), { trusted: () => trusted }));
        const page: string[] = [];
        return { fired, page };
    }
    const press = (target: EventTarget = document.body, init: KeyboardEventInit = { key: "k", code: "KeyK", altKey: true }) => {
        const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, ...init });
        target.dispatchEvent(e);
        return e;
    };

    it("before-page fires first and the page never sees the key", () => {
        const { fired, page } = setup("before-page");
        const onPage = () => page.push("page");
        window.addEventListener("keydown", onPage, true);
        document.addEventListener("keydown", onPage);
        const e = press();
        window.removeEventListener("keydown", onPage, true);
        document.removeEventListener("keydown", onPage);
        expect(fired).toEqual(["1"]);
        expect(page).toEqual([]);
        expect(e.defaultPrevented).toBe(true);
        // other keys go through untouched
        const other = press(document.body, { key: "j", code: "KeyJ", altKey: true });
        expect(other.defaultPrevented).toBe(false);
        expect(fired).toEqual(["1"]);
    });

    it("after-page yields to a page that handled the key (even on window, registered later)", () => {
        const { fired } = setup("after-page");
        const handled = (e: KeyboardEvent) => e.preventDefault();
        window.addEventListener("keydown", handled);
        press();
        window.removeEventListener("keydown", handled);
        expect(fired).toEqual([]);
        const stopper = (e: KeyboardEvent) => e.stopPropagation();
        document.body.addEventListener("keydown", stopper);
        press();
        document.body.removeEventListener("keydown", stopper);
        expect(fired).toEqual([]);
        const e = press();
        expect(fired).toEqual(["1"]);
        expect(e.defaultPrevented).toBe(true);
    });

    it("ignores keys typed in text fields, and synthetic events", () => {
        const { fired } = setup("before-page");
        document.body.innerHTML = "<input id=i><div id=d contenteditable=true></div>";
        const e = press(document.getElementById("i")!);
        expect(e.defaultPrevented).toBe(false);
        press(document.getElementById("d")!);
        expect(fired).toEqual([]);
        stops.pop()!();
        const untrusted = setup("before-page", false);
        press();
        expect(untrusted.fired).toEqual([]);
    });

    it("stops listening", () => {
        const { fired } = setup("before-page");
        stops.pop()!();
        press();
        expect(fired).toEqual([]);
    });
});

describe("shortcut params: recording, showing, checking", () => {
    it("records a pressed combo as portable keys (Mod = the platform's main modifier) that match the same press", () => {
        const cases: [KeyLike, boolean, string][] = [
            [key("K", "KeyK", { ctrlKey: true, shiftKey: true }), false, "Mod+Shift+K"],
            [key("k", "KeyK", { metaKey: true, shiftKey: true }), true, "Mod+Shift+K"],
            [key("k", "KeyK", { ctrlKey: true }), true, "Ctrl+K"],
            [key("k", "KeyK", { metaKey: true }), false, "Meta+K"],
            [key("ø", "KeyO", { altKey: true }), true, "Alt+O"], // Option changes the character on macOS
            [key("?", "Slash", { shiftKey: true }), false, "Shift+/"],
            [key("!", "Digit1", { ctrlKey: true, shiftKey: true }), false, "Mod+Shift+1"],
            [key("F2", "F2"), false, "F2"],
            [key(" ", "Space", { ctrlKey: true }), false, "Mod+Space"],
            [key("ArrowUp", "ArrowUp", { altKey: true }), false, "Alt+Up"],
            [key("Escape", "Escape", { shiftKey: true }), false, "Shift+Esc"],
            [key("Л", "KeyK", { ctrlKey: true }), false, "Mod+K"], // non-Latin layouts: the key's position
        ];
        for (const [e, mac, want] of cases) {
            expect(shortcutFromEvent(e, mac)).toBe(want);
            expect(matchesCombo(parseShortcut(want, mac), e)).toBe(true);
        }
    });

    it("records nothing while only modifiers are down", () => {
        expect(shortcutFromEvent(key("Shift", "ShiftLeft", { shiftKey: true }), false)).toBeNull();
        expect(shortcutFromEvent(key("Meta", "MetaLeft", { metaKey: true }), true)).toBeNull();
        expect(shortcutFromEvent(key("Unidentified", ""), false)).toBeNull();
    });

    it("shows keys as keycaps: symbols in macOS order there, names elsewhere", () => {
        expect(formatShortcut("Mod+Shift+K", true)).toEqual(["⇧", "⌘", "K"]);
        expect(formatShortcut("Mod+Shift+K", false)).toEqual(["Ctrl", "Shift", "K"]);
        expect(formatShortcut("Meta+Ctrl+Alt+Shift+k", true)).toEqual(["⌃", "⌥", "⇧", "⌘", "K"]);
        expect(formatShortcut("Alt+Up", false)).toEqual(["Alt", "↑"]);
        expect(formatShortcut("Ctrl+Space", false)).toEqual(["Ctrl", "Space"]);
        expect(formatShortcut("Shift+Esc", false)).toEqual(["Shift", "Esc"]);
        expect(formatShortcut("", false)).toEqual([]);
        expect(formatShortcut("Hyper+K", false)).toEqual(["Hyper+K"]);
    });

    it("a shortcut param's value: keys ctx.shortcut takes, or \"\" for none", () => {
        expect(isShortcut("")).toBe(true);
        expect(isShortcut("Mod+K")).toBe(true);
        expect(isShortcut("Hyper+K")).toBe(false);
        expect(isShortcut(42)).toBe(false);
    });
});
