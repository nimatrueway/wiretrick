/**
 * Transient bottom-center notice ("Copied to clipboard"). One element per
 * page, reused; announced politely to screen readers; never takes focus.
 */
let el: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string, ms = 1500): void {
    if (!el || !el.isConnected) {
        el = document.createElement("div");
        el.className = "wt-toast";
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        document.body.append(el);
    }
    const t = el;
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove("show"), ms);
}

/** copy to the clipboard (execCommand fallback where the async API is unavailable/denied) */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        const prev = document.activeElement as HTMLElement | null;
        document.body.append(ta);
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {}
        ta.remove();
        prev?.focus?.({ preventScroll: true });
        return ok;
    }
}

export async function copyWithToast(text: string): Promise<void> {
    showToast((await copyText(text)) ? "Copied to clipboard" : "Couldn't copy to clipboard");
}
