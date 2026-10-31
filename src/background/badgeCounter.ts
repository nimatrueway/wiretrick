import { matchAny } from "../shared/matcher";
import type { Script } from "./engine/scriptStore";

/**
 * Per-tab set of the scripts active on a tab: enabled scripts matching the
 * page URL or any of its requests since the tab's last page load. Scripts
 * disabled (or left without routes) since they matched stop counting.
 */
export function createBadgeCounter(scripts: () => readonly Script[]) {
    const tabs = new Map<number, Set<string>>();
    return {
        /** Record the scripts matching `url` on the tab; `newPage` starts the tab over. Returns the active count. */
        note(tabId: number, url: string | undefined, newPage = false): number {
            if (newPage) tabs.delete(tabId);
            if (!url || !/^https?:/i.test(url)) return newPage ? 0 : this.count(tabId);
            let set = tabs.get(tabId);
            if (!set) tabs.set(tabId, (set = new Set()));
            const live = new Set<string>();
            for (const s of scripts()) {
                if (!s.enabled || !s.meta.active) continue;
                live.add(s.id);
                if (matchAny(s.meta.match, url)) set.add(s.id);
            }
            for (const id of set) if (!live.has(id)) set.delete(id);
            return set.size;
        },
        /** Active count without recording anything. */
        count(tabId: number): number {
            const set = tabs.get(tabId);
            if (!set) return 0;
            const live = new Set(scripts().filter((s) => s.enabled && s.meta.active).map((s) => s.id));
            for (const id of set) if (!live.has(id)) set.delete(id);
            return set.size;
        },
        forget(tabId: number): void {
            tabs.delete(tabId);
        },
    };
}
