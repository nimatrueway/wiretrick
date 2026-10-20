/**
 * Browser-action popup: list scripts, toggle them, edit their parameters
 * inline, open the full manager on a specific script.
 */
import { scriptHealth } from "../../shared/scriptHealth";
import { useEffect, useState } from "preact/hooks";
import { Switch } from "../components/Switch";
import { ParamField } from "../components/ParamField";
import { IconPen } from "../components/icons";
import type { PopupApi, ScriptInfo, ScriptParams } from "./api";

type Load = { state: "loading" } | { state: "ready"; scripts: ScriptInfo[] } | { state: "error" };

export function Popup({ api }: { api: PopupApi }) {
    const [load, setLoad] = useState<Load>({ state: "loading" });

    const refresh = async () => {
        try {
            setLoad({ state: "ready", scripts: await api.listScripts() });
        } catch {
            setLoad({ state: "error" });
        }
    };
    useEffect(() => void refresh(), []);

    // libraries (no wt.declareScript) never appear in the popup — they're
    // inert on their own and only imported by other scripts
    const visible = load.state === "ready" ? load.scripts.filter((s) => s.meta.declared !== false) : [];

    return (
        <>
            <div id="header">
                <span id="title">Wiretrick</span>
                <button id="btn-manager" title="Open full manager" onClick={() => api.openManager()}>
                    Manage all
                </button>
            </div>
            <ul id="script-list">
                {visible.map((s) => (
                    <ScriptRow key={s.id} script={s} api={api} onChanged={refresh} />
                ))}
            </ul>
            {load.state === "error" && <div id="empty">Could not reach the extension — close and reopen the popup.</div>}
            {load.state === "ready" && load.scripts.length === 0 && (
                <div id="empty">No scripts yet — open the manager to create one.</div>
            )}
            <ResizeGrip api={api} />
        </>
    );
}

function ScriptRow({ script, api, onChanged }: { script: ScriptInfo; api: PopupApi; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const hasParams = !!script.paramDefs && Object.keys(script.paramDefs).length > 0;
    const health = scriptHealth(script);
    return (
        <>
            <li class="script-item">
                <Switch
                    on={script.enabled}
                    title={script.enabled ? "Disable" : "Enable"}
                    onToggle={async (next) => {
                        await api.setEnabled(script.id, next);
                        onChanged();
                    }}
                />
                <span class={health ? "script-name error" : "script-name"}>{script.meta.name}</span>
                {health && (
                    <span
                        class={`err-ind ${health.kind}`}
                        role="img"
                        aria-label={health.kind === "compile" ? "compile error" : "runtime error"}
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
                <button class="btn-icon" title="Open in full manager" aria-label="Edit" onClick={() => api.openManager(script.id)}>
                    <IconPen />
                </button>
                {hasParams && (
                    <button
                        class="btn-fold"
                        title={open ? "Hide parameters" : "Show parameters"}
                        aria-label="Toggle parameters"
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                    >
                        {open ? "▾" : "▸"}
                    </button>
                )}
            </li>
            {open && <ParamFold scriptId={script.id} api={api} />}
        </>
    );
}

function ParamFold({ scriptId, api }: { scriptId: string; api: PopupApi }) {
    const [params, setParams] = useState<ScriptParams | null>(null);
    useEffect(() => {
        let live = true;
        api.getParams(scriptId).then((p) => live && setParams(p));
        return () => void (live = false);
    }, [scriptId]);

    if (!params) return <li class="param-fold">Loading…</li>;
    const entries = Object.entries(params.defs);
    return (
        <li class="param-fold">
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
        const move = (ev: MouseEvent) => applySize(w0 + ev.clientX - x0, h0 + ev.clientY - y0);
        const up = (ev: MouseEvent) => {
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
