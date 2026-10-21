/** Dark/light theme for the manager and popup: Settings → Appearance. */

export type ThemePref = "system" | "dark" | "light";
export type Theme = "dark" | "light";
export const THEME_KEY = "resTheme";
const LOCAL_KEY = "wtTheme";

export function resolveTheme(pref: unknown, systemLight: boolean): Theme {
    if (pref === "light" || pref === "dark") return pref;
    return systemLight ? "light" : "dark";
}

/**
 * Track the theme: applies <html data-theme>, follows the OS when the
 * choice is "system", and reacts to changes from any extension page.
 * `onChange` gets the effective theme now and on every change.
 */
export function watchTheme(onChange?: (t: Theme, pref: ThemePref) => void): void {
    const mq = matchMedia("(prefers-color-scheme: light)");
    let pref: ThemePref = (localStorage.getItem(LOCAL_KEY) as ThemePref) || "system";
    const apply = () => {
        const t = resolveTheme(pref, mq.matches);
        document.documentElement.dataset.theme = t;
        onChange?.(t, pref);
    };
    const set = (p: unknown) => {
        pref = p === "light" || p === "dark" ? p : "system";
        localStorage.setItem(LOCAL_KEY, pref);
        apply();
    };
    apply();
    chrome.storage.local.get(THEME_KEY, (d) => set(d?.[THEME_KEY]));
    chrome.storage.onChanged.addListener((c, area) => {
        if (area === "local" && THEME_KEY in c) set(c[THEME_KEY].newValue);
    });
    mq.addEventListener("change", apply);
}

export function saveTheme(pref: ThemePref): void {
    chrome.storage.local.set({ [THEME_KEY]: pref });
}
