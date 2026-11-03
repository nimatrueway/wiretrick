import { proxy, ref } from "valtio";
import { LogBadge, NetBadge } from "../logBadge";
import { problemCounts, ProblemsBadge, type ProblemGroup } from "../problems";
import type { NetStore } from "../network/netStore";

/** Each view's counts, shown in the status bar until that view is cleared. */
export const badges = { problems: new ProblemsBadge(), log: new LogBadge(), network: new NetBadge() };

/** The panel's views' state (which view is open lives in `layout`). */
export const panel = proxy({
    /** the status bar shows the counts (Settings → Log) */
    statusBar: true,
    /** bumped when a count in `badges` changes */
    badgeVersion: 0,
    /** the Network view's recording, from the first time it is shown */
    net: null as NetStore | null,
    /** the Problems view: every file's problems, in explorer order */
    problems: ref([]) as ProblemGroup[],
    problemsFilter: "",
    /** the panel's diagnostics button while a report is collected, and for a moment after */
    diagnostics: null as null | { state: "busy" | "ok" | "error"; title: string },
});

export const badgesChanged = (): void => void panel.badgeVersion++;

export function setNetStore(store: NetStore): void {
    panel.net = ref(store);
}

export function setProblems(groups: ProblemGroup[]): void {
    badges.problems.set(problemCounts(groups));
    panel.problems = ref(groups);
    badgesChanged();
}

