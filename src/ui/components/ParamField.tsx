import { useEffect, useRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Switch } from "./Switch";

export interface ParamDef {
    type: "boolean" | "number" | "string" | "enum" | "stringList";
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
