/** One item per panel view, with its counts (filled in by editor.ts). */
export function StatusBar() {
    return (
        <footer id="status-bar" aria-label="Status bar">
            <button id="sb-problems" className="sb-item" data-panel="problems" title="Problems" aria-label="Show the Problems view">
                <span className="sb-pair">
                    <svg className="sb-ico error" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.3" /></svg>
                    <span className="sb-n" data-k="error">0</span>
                </span>
                <span className="sb-pair">
                    <svg className="sb-ico warn" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 6.5v3.5M8 11.5v.6" stroke="currentColor" strokeWidth="1.3" /></svg>
                    <span className="sb-n" data-k="warn">0</span>
                </span>
            </button>
            {" "}
            <button id="sb-log" className="sb-item" data-panel="log" title="Log" aria-label="Show the Log">
                <svg className="sb-kind" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                <span className="sb-label">Log</span>
                <span className="sb-pair">
                    <svg className="sb-ico error" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.3" /></svg>
                    <span className="sb-n" data-k="error">0</span>
                </span>
                <span className="sb-pair">
                    <svg className="sb-ico warn" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 6.5v3.5M8 11.5v.6" stroke="currentColor" strokeWidth="1.3" /></svg>
                    <span className="sb-n" data-k="warn">0</span>
                </span>
            </button>
            {" "}
            <button id="sb-net" className="sb-item" data-panel="network" title="Network" aria-label="Show the Network view">
                <svg className="sb-kind" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="sb-label">Network</span>
                <span className="sb-pair">
                    <svg className="sb-ico modified" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor" /></svg>
                    <span className="sb-n" data-k="modified">0</span>
                </span>
                <span className="sb-pair">
                    <svg className="sb-ico observed" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.6" /></svg>
                    <span className="sb-n" data-k="observed">0</span>
                </span>
            </button>
        </footer>
    );
}
