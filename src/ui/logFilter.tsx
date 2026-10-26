import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { FilterBar, effectiveQuery, initialFilterState } from "./network/NetFilterBar";
import { compileQuery, parseQuery, type QNode } from "./network/netQuery";
import { LOG, logHighlight, type LogLine, type LogSuggest } from "./logQuery";

export interface LogFilter {
    test: (l: LogLine) => boolean;
    /** what to highlight in shown lines */
    mark: RegExp | null;
}

function LogFilterBar({ data, onFilter }: { data: () => LogSuggest; onFilter: (f: LogFilter) => void }) {
    const [fq, setFq] = useState(() => initialFilterState(LOG));
    const query = effectiveQuery(fq, LOG);
    const parsed = useMemo(() => parseQuery(query, LOG), [query]);
    // while the query has an error, keep filtering by the last valid one
    const lastGood = useRef<{ query: string; ast: QNode | null }>({ query: "", ast: null });
    if (!parsed.error) lastGood.current = { query, ast: parsed.ast };
    const good = lastGood.current;
    useEffect(() => onFilter({ test: compileQuery<LogLine, null>(good.ast, null), mark: logHighlight(good.ast) }), [good.query]);
    return (
        <div class="net-toolbar">
            <FilterBar dialect={LOG} state={fq} onChange={setFq} error={parsed.error} data={data()} />
        </div>
    );
}

/** The Log's filter bar (Basic chips / Advanced query, as in Network), in `host`; `onFilter` gets every new filter. */
export function mountLogFilter(host: HTMLElement, data: () => LogSuggest, onFilter: (f: LogFilter) => void): void {
    render(<LogFilterBar data={data} onFilter={onFilter} />, host);
}
