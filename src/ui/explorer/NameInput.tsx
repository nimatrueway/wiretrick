import { useLayoutEffect, useRef } from "react";
import { cleanScriptName, MAX_PATH } from "../../shared/scriptName";
import type { NewKind } from "../state/explorer";

const KIND_TITLE: Record<NewKind, string> = {
    script: 'The name is also the file name: any characters except < > : " \\ | ? * — a / puts the script in a folder (e.g. mock/helpers)',
    data: "A .json, .md or .svg file — a / puts it in a folder (e.g. README.md or mock/users.json)",
    folder: "A folder — a / makes nested folders (e.g. mock/api)",
};

/**
 * The explorer's inline name input (rename / new item): strips forbidden
 * characters as you type; Enter/blur commits, Escape cancels — `onDone` runs once.
 */
export function NameInput({ kind, value, placeholder, range, onDone }: { kind: NewKind; value: string; placeholder?: string; range?: [number, number]; onDone: (commit: boolean, value: string) => void }) {
    const input = useRef<HTMLInputElement>(null);
    const done = useRef(false);
    const end = (commit: boolean): void => {
        if (done.current) return;
        done.current = true;
        onDone(commit, input.current!.value);
    };
    useLayoutEffect(() => {
        const el = input.current!;
        el.focus();
        if (range) el.setSelectionRange(...range);
    }, []);
    const stop = (e: { stopPropagation(): void }): void => e.stopPropagation();
    return (
        <input
            ref={input}
            className="script-rename"
            defaultValue={value}
            maxLength={MAX_PATH}
            title={KIND_TITLE[kind]}
            spellCheck={false}
            placeholder={placeholder}
            onInput={() => {
                const el = input.current!;
                const clean = cleanScriptName(el.value);
                if (clean === el.value) return;
                const pos = Math.max(0, (el.selectionStart ?? clean.length) - (el.value.length - clean.length));
                el.value = clean;
                el.setSelectionRange(pos, pos);
                el.classList.add("rejected");
                setTimeout(() => el.classList.remove("rejected"), 300);
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter") end(true);
                else if (e.key === "Escape") end(false);
                else return;
                e.preventDefault();
                e.stopPropagation();
            }}
            onBlur={() => end(true)}
            onClick={stop}
            onDoubleClick={stop}
            onMouseDown={stop}
        />
    );
}
