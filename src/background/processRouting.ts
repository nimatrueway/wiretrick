/**
 * chrome.proxy routing for the "process" tier.
 *
 * Installs a PAC (shared/pac.ts) that sends hosts of process-owned
 * scripts to the local helper and everything else exactly where the
 * user's own proxy setting sent it. The user's setting is captured
 * before we take control (and persisted, since ours masks it while it's
 * active); clearing ours restores it automatically.
 */
import { buildPac, buildUserDecision, PROBE_HOST, type SystemProxyInfo, type UserDecision, type UserProxyValue } from "../shared/pac";
import { dlogLevel } from "../shared/debugLog";

const CAPTURE_KEY = "resUserProxy";

export type RoutingResult =
    | { ok: true; decision: UserDecision }
    | { ok: false; reason: string };

function proxyApi(): any {
    return (chrome as any).proxy;
}

function settingsGet(): Promise<{ value: any; levelOfControl: string }> {
    return new Promise((resolve) => {
        const api = proxyApi();
        if (!api?.settings) return resolve({ value: null, levelOfControl: "not_controllable" });
        api.settings.get({ incognito: false }, (d: any) => {
            void chrome.runtime.lastError;
            resolve(d || { value: null, levelOfControl: "not_controllable" });
        });
    });
}

function settingsSet(value: any): Promise<string | null> {
    return new Promise((resolve) => {
        proxyApi().settings.set({ value, scope: "regular" }, () => resolve(chrome.runtime.lastError?.message || null));
    });
}

function settingsClear(): Promise<void> {
    return new Promise((resolve) => {
        const api = proxyApi();
        if (!api?.settings) return resolve();
        api.settings.clear({ scope: "regular" }, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

async function fetchText(url: string, ms = 5000): Promise<string | null> {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        return r.ok ? await r.text() : null;
    } catch {
        return null;
    }
}

function isOurs(value: any): boolean {
    return value?.mode === "pac_script" && typeof value?.pacScript?.data === "string" && value.pacScript.data.startsWith("// ResScript Override");
}

export class ProcessRouting {
    private installedPac: string | null = null;
    private installedHosts = "";
    private user: UserProxyValue | null = null;
    private userFetched: { key: string; text: string | null } | null = null;
    /** set while our PAC is active; reasons for unavailability otherwise */
    status: { active: boolean; reason?: string; mode?: string; note?: string } = { active: false };

    constructor() {
        try {
            proxyApi()?.settings?.onChange?.addListener((d: any) => this.onSettingChange(d));
        } catch {
            /* Firefox: the process tier is disabled there anyway */
        }
    }

    private onSettingChange(d: any): void {
        if (isOurs(d?.value)) return;
        if (d?.levelOfControl === "controlled_by_other_extensions" || d?.levelOfControl === "not_controllable") {
            dlogLevel("process", "warn", `proxy setting taken over (${d.levelOfControl}) — process tier routing inactive`);
            this.installedPac = null;
            this.status = { active: false, reason: d.levelOfControl === "not_controllable" ? "the proxy setting is locked by policy" : "another extension controls the proxy setting" };
            this.onLost?.();
        }
    }

    /** called when routing is lost underneath us (another extension took over) */
    onLost?: () => void;

    /** the user's proxy setting (captured before ours took effect) */
    private async userSetting(): Promise<{ value: UserProxyValue | null; blocked?: string }> {
        const cur = await settingsGet();
        if (cur.levelOfControl === "controlled_by_other_extensions") return { value: null, blocked: "another extension controls the proxy setting" };
        if (cur.levelOfControl === "not_controllable") return { value: null, blocked: "the proxy setting is locked by policy (or chrome.proxy is unavailable)" };
        if (cur.levelOfControl === "controlled_by_this_extension" || isOurs(cur.value)) {
            const got = await chrome.storage.local.get(CAPTURE_KEY);
            return { value: got?.[CAPTURE_KEY] ?? { mode: "system" } };
        }
        // controllable_by_this_extension: the value in effect IS the user's
        const value = (cur.value as UserProxyValue) || { mode: "system" };
        await chrome.storage.local.set({ [CAPTURE_KEY]: value });
        return { value };
    }

    /** the text of the PAC the user's setting points at (cached per url) */
    private async fetchedPac(user: UserProxyValue | null, system: SystemProxyInfo | null): Promise<string | null> {
        let url: string | null = null;
        if (user?.mode === "pac_script" && !user.pacScript?.data) url = user.pacScript?.url || null;
        else if (user?.mode === "auto_detect") url = "http://wpad/wpad.dat";
        else if ((user?.mode || "system") === "system" && system?.pacUrl) url = system.pacUrl;
        if (!url) return null;
        if (this.userFetched?.key === url) return this.userFetched.text;
        // fetched BEFORE our PAC is (re)installed for this url's host: the
        // extension's own request follows the currently effective setting
        const text = await fetchText(url);
        this.userFetched = { key: url, text };
        return text;
    }

    /** the decision for intercepted traffic (also used by needUpstream) */
    async decision(system: SystemProxyInfo | null): Promise<RoutingResult> {
        const { value, blocked } = await this.userSetting();
        if (blocked) return { ok: false, reason: blocked };
        this.user = value;
        const d = buildUserDecision(value, system, await this.fetchedPac(value, system));
        return { ok: true, decision: d };
    }

    /**
     * Install (or refresh) the PAC routing `patterns` to the helper on
     * `port`. Returns the user decision in effect, or why routing is off.
     */
    async apply(port: number, patterns: string[], system: SystemProxyInfo | null): Promise<RoutingResult> {
        const res = await this.decision(system);
        if (!res.ok) {
            this.status = { active: false, reason: res.reason };
            return res;
        }
        const pac = buildPac(port, patterns, res.decision);
        if (pac !== this.installedPac) {
            const err = await settingsSet({ mode: "pac_script", pacScript: { data: pac, mandatory: false } });
            if (err) {
                this.status = { active: false, reason: `chrome.proxy.settings.set failed: ${err}` };
                return { ok: false, reason: this.status.reason! };
            }
            this.installedPac = pac;
            dlogLevel("process", "info", `PAC installed: ${patterns.length} pattern(s) → 127.0.0.1:${port}; other traffic → ${this.user?.mode || "system"} (${res.decision.upstream})`);
        }
        const hosts = JSON.stringify([...new Set(patterns)].sort());
        if (hosts !== this.installedHosts) {
            this.installedHosts = hosts;
            await this.dropCache(patterns);
        }
        this.status = { active: true, mode: this.user?.mode || "system", note: res.decision.note };
        return res;
    }

    /** remove our PAC (Chrome restores the user's setting) */
    async clear(): Promise<void> {
        this.status = { active: false };
        if (this.installedPac === null) {
            // a previous SW instance may have left ours installed
            const cur = await settingsGet();
            if (!isOurs(cur.value)) return;
        }
        this.installedPac = null;
        this.installedHosts = "";
        await settingsClear();
        dlogLevel("process", "info", "PAC removed — the browser's own proxy setting is back in effect");
    }

    /**
     * Cached responses would bypass the helper: drop the cache for routed
     * literal origins (wildcard hosts can't be enumerated — transformed
     * responses are served no-store, so only pre-existing entries linger).
     */
    private async dropCache(patterns: string[]): Promise<void> {
        const bd = (chrome as any).browsingData;
        if (!bd?.removeCache) return;
        const origins = new Set<string>();
        for (const p of patterns) {
            const m = /^(https?|\*):\/\/([^/*]+)\//i.exec(p);
            if (!m) continue;
            const schemes = m[1] === "*" ? ["http", "https"] : [m[1].toLowerCase()];
            for (const s of schemes) origins.add(`${s}://${m[2].toLowerCase()}`);
        }
        if (!origins.size) return;
        await new Promise<void>((resolve) => {
            try {
                bd.removeCache({ origins: [...origins] }, () => {
                    void chrome.runtime.lastError;
                    resolve();
                });
            } catch {
                resolve();
            }
        });
    }

    /** true when Chrome reaches the helper through our PAC AND trusts its CA */
    async probe(): Promise<boolean> {
        return (await fetchText(`https://${PROBE_HOST}/`, 4000)) !== null;
    }
}
