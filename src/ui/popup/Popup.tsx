/**
 * Browser-action popup: list scripts, toggle them, edit their parameters
 * inline, open the full manager on a specific script.
 */
import { scriptHealth } from "../../shared/scriptHealth";
import { useEffect, useState, type MouseEvent } from "react";
import { Switch } from "../components/Switch";
import { ParamField } from "../components/ParamField";
import { IconPen } from "../components/icons";
import type { PopupApi, ScriptInfo, ScriptParams } from "./api";

type Load = { state: "loading" } | { state: "ready"; scripts: ScriptInfo[] } | { state: "error" };

export function Popup({ api }: { api: PopupApi }) {
    const [load, setLoad] = useState<Load>({ state: "loading" });
    // scripts counted in the toolbar badge for the current tab
    const [active, setActive] = useState<ReadonlySet<string>>(new Set());
    const refreshActive = () =>
        api.activeOnTab().then(
            (ids) => setActive((prev) => (sameIds(prev, ids) ? prev : new Set(ids))),
            () => {}
        );

    const refresh = async () => {
        void refreshActive();
        try {
            setLoad({ state: "ready", scripts: await api.listScripts() });
        } catch {
            setLoad({ state: "error" });
        }
    };
    // bumped on outside changes so open param folds re-fetch too
    const [version, setVersion] = useState(0);
    useEffect(() => {
        void refresh();
        let t: ReturnType<typeof setTimeout> | undefined;
        const off = api.onChange?.(() => {
            clearTimeout(t);
            t = setTimeout(() => {
                void refresh();
                setVersion((v) => v + 1);
            }, 150);
        });
        // the page keeps making requests while the popup is open
        const poll = setInterval(refreshActive, 1500);
        return () => {
            clearTimeout(t);
            clearInterval(poll);
            off?.();
        };
    }, []);

    // utilities (no handlers) appear only when they declare params — a
    // param value may turn one into a script (handlers registered under
    // `if (p.on)`), and imported helpers may read them
    const visible = load.state === "ready" ? load.scripts.filter((s) => s.meta.active !== false || hasParams(s)) : [];
    const nActive = visible.filter((s) => active.has(s.id)).length;

    return (
        <>
            <div id="header">
                <span id="title">TangiTweak</span>
                {nActive > 0 && (
                    <span id="active-summary" title="Scripts counted in the toolbar badge: enabled, and matched this tab's page or one of its requests since it loaded">
                        <span className="active-dot" />
                        {nActive} active on this tab
                    </span>
                )}
                <button id="btn-manager" title="Open the Editor" onClick={() => api.openManager()}>
                    Open Editor
                </button>
            </div>
            <ul id="script-list">
                {visible.map((s) => (
                    <ScriptRow key={s.id} script={s} api={api} onChanged={refresh} version={version} activeHere={active.has(s.id)} />
                ))}
            </ul>
            {load.state === "error" && <div id="empty">Could not reach the extension — close and reopen the popup.</div>}
            {load.state === "ready" && load.scripts.length === 0 && (
                <div id="empty">No scripts yet — open the Editor to create one.</div>
            )}
            <ResizeGrip api={api} />
        </>
    );
}

const sameIds = (a: ReadonlySet<string>, b: string[]) => a.size === b.length && b.every((id) => a.has(id));

const hasParams = (s: ScriptInfo) => !!s.paramDefs && Object.keys(s.paramDefs).length > 0;

function ScriptRow({ script, api, onChanged, version, activeHere }: { script: ScriptInfo; api: PopupApi; onChanged: () => void; version: number; activeHere: boolean }) {
    const [open, setOpen] = useState(false);
    const isLib = script.meta.active === false;
    const health = scriptHealth(script);
    return (
        <>
            <li className={"script-item" + (isLib ? " utility" : "") + (activeHere ? " active-here" : "")}>
                {isLib ? (
                    // utilities have no enabled switch (same as the manager / settings.yaml)
                    <span className="util-ind" role="img" aria-label="library" title="Library — registers no handlers with its current params; importable by other scripts">
                        𝑓
                    </span>
                ) : (
                    <Switch
                        on={script.enabled}
                        title={script.enabled ? "Disable" : "Enable"}
                        onToggle={async (next) => {
                            await api.setEnabled(script.id, next);
                            onChanged();
                        }}
                    />
                )}
                <span
                    className="active-ind"
                    role={activeHere ? "img" : undefined}
                    aria-label={activeHere ? "active on this tab" : undefined}
                    title={activeHere ? "Active on this tab — matched the page or one of its requests (counted in the badge)" : undefined}
                />
                <span className={health ? "script-name error" : "script-name"} title={script.meta.description}>
                    {script.meta.name}
                </span>
                {health && (
                    <span
                        className={`err-ind ${health.kind}`}
                        role="img"
                        aria-label={`${health.kind === "types" ? "type" : health.kind} error`}
                        title={health.tooltip}
                        onClick={
                            health.kind === "runtime"
                                ? async () => {
                                      await api.clearError(script.id);
                                      onChanged();
                                  }
                                : undefined
                        }
                    >
                        ⚠
                    </span>
                )}
                <button className="btn-icon" title="Open in the Editor" aria-label="Edit" onClick={() => api.openManager(script.id)}>
                    <IconPen />
                </button>
                {hasParams(script) && (
                    <button
                        className="btn-fold"
                        title={open ? "Hide parameters" : "Show parameters"}
                        aria-label="Toggle parameters"
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                    >
                        {open ? "▾" : "▸"}
                    </button>
                )}
            </li>
            {open && <ParamFold scriptId={script.id} api={api} version={version} />}
        </>
    );
}

function ParamFold({ scriptId, api, version }: { scriptId: string; api: PopupApi; version: number }) {
    const [params, setParams] = useState<ScriptParams | null>(null);
    useEffect(() => {
        let live = true;
        api.getParams(scriptId).then((p) => live && setParams(p));
        return () => void (live = false);
    }, [scriptId, version]);

    if (!params) return <li className="param-fold">Loading…</li>;
    const entries = Object.entries(params.defs);
    return (
        <li className="param-fold">
            {entries.length === 0
                ? "This script declares no parameters."
                : entries.map(([key, def]) => (
                      <ParamField
                          key={key}
                          name={key}
                          def={def}
                          value={params.values[key]}
                          onChange={(v) => {
                              setParams({ ...params, values: { ...params.values, [key]: v } });
                              void api.setParam(scriptId, key, v);
                          }}
                      />
                  ))}
        </li>
    );
}

// Chrome ignores CSS resize on the popup viewport; dragging the grip sets
// an explicit body size and the window follows.
const MIN_W = 320;
const MIN_H = 160;
const MAX_W = 780; // Chrome popup ceiling
const MAX_H = 580;
const clampSize = (w: number, h: number) => ({
    w: Math.max(MIN_W, Math.min(MAX_W, w)),
    h: Math.max(MIN_H, Math.min(MAX_H, h)),
});
function applySize(w: number, h: number): void {
    const s = clampSize(w, h);
    document.body.style.width = `${s.w}px`;
    document.body.style.height = `${s.h}px`;
}

function ResizeGrip({ api }: { api: PopupApi }) {
    useEffect(() => {
        api.loadSize().then((s) => s && applySize(s.w, s.h));
    }, []);
    const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        const body = document.body;
        body.classList.add("resizing");
        const [x0, y0, w0, h0] = [e.clientX, e.clientY, body.offsetWidth, body.offsetHeight];
        const move = (ev: globalThis.MouseEvent) => applySize(w0 + ev.clientX - x0, h0 + ev.clientY - y0);
        const up = (ev: globalThis.MouseEvent) => {
            body.classList.remove("resizing");
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            api.saveSize(clampSize(w0 + ev.clientX - x0, h0 + ev.clientY - y0));
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };
    return <div id="resize-grip" title="Drag to resize" onMouseDown={onMouseDown} />;
}
