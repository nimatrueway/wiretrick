/** Keyboard shortcuts listed in the "?" dialog. "Mod" = ⌘ on macOS, Ctrl elsewhere. */
export interface Shortcut {
    keys: string[];
    /** different keys on macOS */
    macKeys?: string[];
    action: string;
    where: string;
}

export const SHORTCUTS: Shortcut[] = [
    { keys: ["Mod+S"], action: "Save and hot-apply the script (or save the data file)", where: "Editor" },
    { keys: ["Mod+P"], action: "Quick open a script, data file or settings.yaml", where: "Global" },
    { keys: ["Mod+,"], action: "Open Settings", where: "Global" },
    { keys: ["F1"], action: "Command palette (all editor commands)", where: "Editor" },
    { keys: ["Mod+Shift+E"], action: "Focus the explorer", where: "Global" },
    { keys: ["Mod+B"], action: "Toggle explorer (left panel)", where: "Global" },
    { keys: ["Mod+J", "Mod+`"], action: "Toggle Problems/Log/Network (bottom panel)", where: "Global" },
    { keys: ["Mod+Shift+M"], action: "Show the Problems view (again: close it)", where: "Global" },
    { keys: ["Alt+Z"], action: "Toggle word wrap", where: "Global" },
    { keys: ["Esc"], action: "Close dialog / return to the editor", where: "Global" },
    { keys: ["↑", "↓", "Home", "End"], action: "Move selection", where: "Explorer" },
    { keys: ["←", "→"], action: "Collapse / expand a folder (←: go to the parent folder)", where: "Explorer" },
    { keys: ["Enter"], action: "Open the file and focus the editor (a folder: collapse / expand)", where: "Explorer" },
    { keys: ["Space"], action: "Open the file, keep focus in the list", where: "Explorer" },
    { keys: ["F2"], action: "Rename (a / in the name moves it into a folder)", where: "Explorer" },
    { keys: ["Delete", "Mod+Backspace"], action: "Delete (asks first; a folder with its contents)", where: "Explorer" },
    { keys: ["↑", "↓", "Enter"], action: "Move through suggestions (+ Filter values too) / pick one", where: "Network filter" },
    { keys: ["Mod+Z"], action: "Undo a Basic filter change (chips too)", where: "Network filter" },
    { keys: ["Mod+Shift+Z", "Mod+Y"], action: "Redo", where: "Network filter" },
    { keys: ["Mod+/"], action: "Toggle line comment", where: "Editor" },
    { keys: ["Mod+F"], action: "Find", where: "Editor" },
    { keys: ["Mod+H"], action: "Replace", where: "Editor" },
    { keys: ["Mod+D"], action: "Add selection to next match", where: "Editor" },
    { keys: ["Mod+Shift+L"], action: "Select all occurrences", where: "Editor" },
    { keys: ["Alt+↑", "Alt+↓"], action: "Move line up/down", where: "Editor" },
    { keys: ["Shift+Alt+↑", "Shift+Alt+↓"], action: "Copy line up/down", where: "Editor" },
    { keys: ["Mod+Shift+K"], action: "Delete line", where: "Editor" },
    { keys: ["Mod+]", "Mod+["], action: "Indent / outdent line", where: "Editor" },
    { keys: ["Shift+Alt+F"], action: "Format document", where: "Editor" },
    { keys: ["F12"], action: "Go to definition", where: "Editor" },
    { keys: ["Alt+F12"], action: "Peek definition", where: "Editor" },
    { keys: ["Shift+F12"], action: "Find references", where: "Editor" },
    { keys: ["Alt+←"], macKeys: ["Ctrl+-"], action: "Go back (after Go to definition or a hover type link)", where: "Global" },
    { keys: ["Alt+→"], macKeys: ["Ctrl+Shift+-"], action: "Go forward", where: "Global" },
    { keys: ["F2"], action: "Rename symbol", where: "Editor" },
    { keys: ["Mod+."], action: "Quick fix", where: "Editor" },
    { keys: ["Mod+Space"], action: "Trigger suggestions", where: "Editor" },
    { keys: ["Mod+Shift+O"], action: "Go to symbol", where: "Editor" },
    { keys: ["Mod+G"], action: "Go to line", where: "Editor" },
    { keys: ["Mod+Shift+["], action: "Fold region", where: "Editor" },
    { keys: ["Mod+Shift+]"], action: "Unfold region", where: "Editor" },
];

/** "Mod+Shift+E" → "⌘⇧E" on macOS, "Ctrl+Shift+E" elsewhere. */
export function formatKey(key: string, mac: boolean): string {
    if (!mac) return key.replace(/Mod/g, "Ctrl");
    const sym: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥", Backspace: "⌫" };
    return key
        .split(/\+(?=.)/)
        .map((p) => sym[p] ?? p)
        .join("");
}

/** the keys of a shortcut on this platform */
export const keysFor = (s: Shortcut, mac: boolean): string[] => (mac && s.macKeys) || s.keys;

/** Every whitespace-separated word must appear in the action, context or keys. */
export function filterShortcuts(list: Shortcut[], query: string, mac: boolean): Shortcut[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return list;
    return list.filter((s) => {
        const keys = keysFor(s, mac);
        const hay = [s.action, s.where, ...keys, ...keys.map((k) => formatKey(k, mac))].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}
