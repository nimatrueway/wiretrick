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

/** One script parameter: label, description and a type-appropriate input.
 * Controlled by `value`; text-like inputs commit on change (blur/enter),
 * switches immediately. */
export function ParamField(props: { name: string; def: ParamDef; value: any; onChange: (value: any) => void }) {
    const { name, def, onChange } = props;

    let control = null;
    if (def.type === "string") {
        control = def.multiline ? (
            <textarea spellcheck={false} value={props.value ?? ""} onChange={(e) => onChange(e.currentTarget.value)} />
        ) : (
            <input type="text" value={props.value ?? ""} onChange={(e) => onChange(e.currentTarget.value)} />
        );
    } else if (def.type === "number") {
        control = (
            <input
                type="number"
                value={String(props.value ?? 0)}
                min={def.min}
                max={def.max}
                step={def.step}
                onChange={(e) => {
                    const n = clampNumber(e.currentTarget.value, def);
                    e.currentTarget.value = String(n);
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
            <textarea
                spellcheck={false}
                placeholder="one value per line"
                value={(Array.isArray(props.value) ? props.value : []).join("\n")}
                onChange={(e) => onChange(parseStringList(e.currentTarget.value))}
            />
        );
    }

    return (
        <div class="param-row">
            <div class="param-label">
                <span>{name}</span>
                {def.type === "boolean" && (
                    <Switch on={!!props.value} onToggle={onChange} />
                )}
            </div>
            {def.description && <div class="param-desc">{def.description}</div>}
            {control}
        </div>
    );
}
