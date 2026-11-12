import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { Switch } from "./Switch";
import { isParamDef, isParamGroup, type ParamTree } from "../../shared/scriptDef";
import { formatShortcut, isMacPlatform, shortcutFromEvent } from "../../shared/shortcut";

export interface ParamDef {
    type: "boolean" | "number" | "string" | "enum" | "stringList" | "shortcut";
    default?: any;
    choices?: string[];
    description?: string;
    min?: number;
    max?: number;
    step?: number;
    multiline?: boolean;
}

export function clampNumber(raw: string, def: Pick<ParamDef, "min" | "max">): number {
    let n = Number(raw);
    if (!isFinite(n)) n = 0;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    return n;
}

export function parseStringList(text: string): string[] {
    return text.split("\n").map((x) => x.trim()).filter(Boolean);
}

type CommitProps = { value: string; onCommit: (el: HTMLInputElement | HTMLTextAreaElement) => void };

/**
 * A text box that reports its value on the native `change` event (blur / Enter / a
 * number spinner), not on every keystroke as React's onChange does; `value`
 * replaces what it shows whenever it changes.
 */
function CommitInput({ value, onCommit, multiline, ...rest }: CommitProps & { multiline?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange">) {
    const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    const commit = useRef(onCommit);
    commit.current = onCommit;
    useEffect(() => {
        if (el.current && el.current.value !== value) el.current.value = value;
    }, [value]);
    useEffect(() => {
        const node = el.current!;
        const on = () => commit.current(node);
        node.addEventListener("change", on);
        return () => node.removeEventListener("change", on);
    }, []);
    return multiline ? <textarea ref={el} defaultValue={value} {...rest} /> : <input ref={el} defaultValue={value} {...rest} />;
}

const Caps = ({ keys }: { keys: string[] }) => (
    <>
        {keys.map((k, i) => (
            <kbd key={i}>{k}</kbd>
        ))}
    </>
);

/**
 * A shortcut param: click, then press the keys (Esc cancels, clicking away
 * too). Held modifiers show while recording. × removes the shortcut, ↺
 * puts the default back.
 */
function ShortcutInput({ value, def, onChange }: { value: string; def: ParamDef; onChange: (v: string) => void }) {
    const mac = isMacPlatform();
    const [rec, setRec] = useState(false);
    const [held, setHeld] = useState<string[]>([]);
    const dflt = typeof def.default === "string" ? def.default : "";
    const stop = () => (setRec(false), setHeld([]));
    const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
        if (!rec) return;
        e.preventDefault();
        e.stopPropagation();
        const n = e.nativeEvent;
        if (n.key === "Escape" && !n.ctrlKey && !n.altKey && !n.shiftKey && !n.metaKey) return stop();
        const keys = shortcutFromEvent(n, mac);
        if (!keys) {
            const mods = mac ? [n.ctrlKey && "⌃", n.altKey && "⌥", n.shiftKey && "⇧", n.metaKey && "⌘"] : [n.ctrlKey && "Ctrl", n.altKey && "Alt", n.shiftKey && "Shift", n.metaKey && "Meta"];
            return setHeld(mods.filter(Boolean) as string[]);
        }
        stop();
        if (keys !== value) onChange(keys);
    };
    const shown = rec ? held : formatShortcut(value, mac);
    return (
        <div className="shortcut-field">
            <button
                type="button"
                className={"shortcut-rec" + (rec ? " recording" : "") + (!rec && !value ? " none" : "")}
                title={rec ? "Press the keys — Esc cancels" : "Click, then press the keys"}
                onClick={() => (rec ? stop() : setRec(true))}
                onKeyDown={onKey}
                onKeyUp={(e) => rec && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && setHeld([])}
                onBlur={stop}
            >
                <Caps keys={shown} />
                {rec ? <span className="shortcut-hint">{held.length ? "…" : "Press keys…"}</span> : !value && <span className="shortcut-hint">None</span>}
            </button>
            {value && !rec && (
                <button type="button" className="btn-icon shortcut-act" aria-label="Remove shortcut" title="Remove shortcut" onClick={() => onChange("")}>
                    ×
                </button>
            )}
            {value !== dflt && dflt && !rec && (
                <button type="button" className="btn-icon shortcut-act" aria-label="Reset to default" title={`Reset to ${formatShortcut(dflt, mac).join(mac ? "" : "+")}`} onClick={() => onChange(dflt)}>
                    ↺
                </button>
            )}
        </div>
    );
}

/** One script parameter: label, description and a type-appropriate input.
 * Controlled by `value`; text-like inputs commit on change (blur/enter),
 * switches immediately. */
export function ParamField(props: { name: string; def: ParamDef; value: any; onChange: (value: any) => void }) {
    const { name, def, onChange } = props;

    let control = null;
    if (def.type === "string") {
        control = def.multiline ? (
            <CommitInput multiline spellCheck={false} value={props.value ?? ""} onCommit={(el) => onChange(el.value)} />
        ) : (
            <CommitInput type="text" value={props.value ?? ""} onCommit={(el) => onChange(el.value)} />
        );
    } else if (def.type === "number") {
        control = (
            <CommitInput
                type="number"
                value={String(props.value ?? 0)}
                min={def.min}
                max={def.max}
                step={def.step}
                onCommit={(el) => {
                    const n = clampNumber(el.value, def);
                    el.value = String(n);
                    onChange(n);
                }}
            />
        );
    } else if (def.type === "enum") {
        control = (
            <select value={props.value ?? def.choices?.[0] ?? ""} onChange={(e) => onChange(e.currentTarget.value)}>
                {(def.choices || []).map((c) => (
                    <option key={c} value={c}>{c}</option>
                ))}
            </select>
        );
    } else if (def.type === "shortcut") {
        control = <ShortcutInput value={typeof props.value === "string" ? props.value : ""} def={def} onChange={onChange} />;
    } else if (def.type === "stringList") {
        control = (
            <CommitInput
                multiline
                spellCheck={false}
                placeholder="one value per line"
                value={(Array.isArray(props.value) ? props.value : []).join("\n")}
                onCommit={(el) => onChange(parseStringList(el.value))}
            />
        );
    }

    return (
        <div className="param-row">
            <div className="param-label">
                <span>{name}</span>
                {def.type === "boolean" && (
                    <Switch on={!!props.value} onToggle={onChange} />
                )}
            </div>
            {def.description && <div className="param-desc">{def.description}</div>}
            {control}
        </div>
    );
}

/**
 * Renders a tree of parameter definitions: leaf controls directly, and
 * nested section objects as collapsible `<details>` groups.
 */
export function ParamTreeFields(props: {
    defs: ParamTree;
    values: Record<string, any> | undefined;
    onChange: (path: string[], value: any) => void;
    prefix?: string[];
}) {
    const prefix = props.prefix ?? [];
    return (
        <>
            {Object.entries(props.defs).map(([key, node]) => {
                const path = [...prefix, key];
                if (isParamDef(node)) {
                    return (
                        <ParamField
                            key={key}
                            name={key}
                            def={node as ParamDef}
                            value={props.values?.[key]}
                            onChange={(v) => props.onChange(path, v)}
                        />
                    );
                }
                if (isParamGroup(node)) {
                    const subVals = props.values && typeof props.values[key] === "object" && !Array.isArray(props.values[key]) ? props.values[key] : undefined;
                    return (
                        <details key={key} className="param-section" open>
                            <summary className="param-section-head">
                                <span className="param-section-chev" aria-hidden="true">▸</span>
                                <span className="param-section-title">{key}</span>
                            </summary>
                            <div className="param-section-body">
                                <ParamTreeFields defs={node} values={subVals} onChange={props.onChange} prefix={path} />
                            </div>
                        </details>
                    );
                }
                return null;
            })}
        </>
    );
}
