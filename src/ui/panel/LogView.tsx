import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useSnapshot } from "valtio";
import { logSegments, opensInTab } from "../logLinks";
import { logState, shownLines, type LogItem, type LogScroll } from "../state/log";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const atEnd = (box: HTMLElement): boolean => box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
const setScroll = (s: LogScroll): void => void (logState.scroll = s);

/** Log links: browser-viewable URIs open in a tab, other schemes (vscode:, mailto:…) go to the OS. */
function openLogLink(e: MouseEvent): void {
    const a = (e.target as Element).closest?.("a.log-link") as HTMLAnchorElement | null;
    if (!a || e.button > 1) return;
    e.preventDefault();
    const uri = a.getAttribute("href")!;
    if (opensInTab(uri)) {
        chrome.tabs.create({ url: uri, active: !(e.metaKey || e.ctrlKey || e.button === 1) }, () => void chrome.runtime.lastError);
        return;
    }
    // external protocols launch only from a user gesture on a page, never chrome.tabs
    const launch = Object.assign(document.createElement("a"), { href: uri });
    document.body.appendChild(launch);
    launch.click();
    launch.remove();
}

const LogLineView = memo(function LogLineView({ e, mark }: { e: LogItem; mark: RegExp | null }) {
    const { text, level } = e;
    // highlight within the message, not the time prefix
    const m = mark?.exec(e.message);
    const at = m ? text.length - e.message.length + m.index : -1;
    return (
        <div className={`log-line ${level}`} data-text={text} data-level={level} data-source={e.source} data-body={text.replace(/^\[[^\]]*\]\s*/, "")}>
            <time>{text.match(/^\[[^\]]*\]/)?.[0] || ""}</time>
            <span className={`lv ${level}`}>{level}</span>
            {logSegments(text, m?.[0] ? [at, at + m[0].length] : undefined).map((seg, i) => {
                const node = seg.mark ? <mark key={i}>{seg.text}</mark> : seg.text;
                if (!seg.uri) return node;
                return (
                    <a key={i} className="log-link" href={seg.uri} title={`${seg.uri}\nClick to open · ${isMac ? "⌘" : "Ctrl"}-click: in the background`}>
                        {node}
                    </a>
                );
            })}
        </div>
    );
});

/** The Log: the newest lines that pass the level and the filter, following the end unless scrolled up or locked. */
export function LogView({ hidden }: { hidden: boolean }) {
    const snap = useSnapshot(logState);
    const lines = useMemo(shownLines, [snap.version, snap.level, snap.cap, snap.filter]);
    const box = useRef<HTMLDivElement>(null);
    /** where we last put the scroll, so our own scrolling isn't mistaken for the user's */
    const ownTop = useRef(0);
    const scroll = snap.scroll;
    useLayoutEffect(() => {
        const b = box.current!;
        if (scroll === "follow") b.scrollTop = b.scrollHeight;
        ownTop.current = b.scrollTop;
    });
    return (
        <div
            id="log-entries"
            ref={box}
            hidden={hidden}
            onClick={(e) => openLogLink(e.nativeEvent)}
            onAuxClick={(e) => openLogLink(e.nativeEvent)}
            // react before the next line yanks the view back down
            onWheel={(e) => {
                if (e.deltaY < 0 && logState.scroll === "follow" && box.current!.scrollTop > 0) setScroll("paused");
            }}
            onScroll={() => {
                const b = box.current!;
                if (logState.scroll === "locked" || Math.abs(b.scrollTop - ownTop.current) < 2) return;
                ownTop.current = b.scrollTop;
                const end = atEnd(b);
                if (end !== (logState.scroll === "follow")) setScroll(end ? "follow" : "paused");
            }}
        >
            {lines.map((e) => (
                <LogLineView key={e.seq} e={e} mark={snap.filter.mark} />
            ))}
        </div>
    );
}
