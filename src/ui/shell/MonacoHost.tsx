import { memo, useLayoutEffect, useRef } from "react";
import { attachHost } from "./codeEditor";

/** Where Monaco draws the Code view. Renders once; Monaco owns everything inside. */
export const MonacoHost = memo(function MonacoHost() {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => attachHost(ref.current!), []);
    return <div id="monaco-host" ref={ref} />;
});
