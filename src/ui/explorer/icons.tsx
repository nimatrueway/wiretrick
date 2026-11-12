/** the Explorer's file icons and tree indentation (also the Export…/Import… picker's) */
import { useEffect, useState, type ReactNode } from "react";

const FOLDER_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8h-13z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;
const FOLDER_OPEN_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 12.5v-9h4.3l1.5 1.5h5.2v2M1.5 12.5l2-5.5h11l-2 5.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;
/** a package's folder: a box */
const PACKAGE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.5l6 3.25v6.5L8 14.5l-6-3.25v-6.5zM2 4.75L8 8l6-3.25M8 8v6.5M5 3.1l6 3.3" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;
/** the explorer twistie (VS Code's chevron-right) */
const CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export type Icon = "ts" | "tsx" | "yaml" | "json" | "svg" | "img" | "folder" | "folder-open" | "package" | "section";

export function FileIcon({ kind, src }: { kind: Icon; src?: string }) {
    const [broken, setBroken] = useState(false);
    useEffect(() => setBroken(false), [src]);
    if (src && !broken) {
        const cls = kind === "package" ? "file-icon folder package custom" : kind === "folder" || kind === "folder-open" ? "file-icon folder custom" : `file-icon ${kind} custom`;
        return (
            <span className={cls} aria-hidden="true">
                <img src={src} alt="" onError={() => setBroken(true)} />
            </span>
        );
    }
    if (kind === "package") return <span className="file-icon folder package" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PACKAGE_ICON }} />;
    const folder = kind === "folder" || kind === "folder-open";
    return folder ? (
        <span className="file-icon folder" aria-hidden="true" dangerouslySetInnerHTML={{ __html: kind === "folder" ? FOLDER_ICON : FOLDER_OPEN_ICON }} />
    ) : (
        <span className={`file-icon ${kind}`} aria-hidden="true">
            {kind === "ts" ? "TS" : kind === "tsx" ? "⚛" : kind === "json" ? "{}" : kind === "svg" || kind === "img" ? "◈" : kind === "section" ? "¶" : "⚙"}
        </span>
    );
}

/** indent guides (one per level) and the twistie: a chevron on folders (`open` = expanded) */
export function indent(depth: number, open?: boolean): ReactNode[] {
    const out: ReactNode[] = [];
    for (let i = 0; i < depth; i++) out.push(<span key={`g${i}`} className="indent-guide" style={{ "--level": String(i) } as any} />);
    const cls = "twistie" + (open === undefined ? "" : open ? " collapsible open" : " collapsible");
    out.push(open === undefined ? <span key="tw" className={cls} aria-hidden="true" /> : <span key="tw" className={cls} aria-hidden="true" dangerouslySetInnerHTML={{ __html: CHEVRON }} />);
    return out;
}
