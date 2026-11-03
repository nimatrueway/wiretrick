import { memo, useLayoutEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { dialogs } from "../state/dialogs";
import { attachHost } from "./codeEditor";

/** Where Monaco draws the Code view; hidden while the welcome page shows. Monaco owns everything inside. */
export const MonacoHost = memo(function MonacoHost() {
    const ref = useRef<HTMLDivElement>(null);
    const { welcome } = useSnapshot(dialogs);
    useLayoutEffect(() => attachHost(ref.current!), []);
    return <div id="monaco-host" ref={ref} hidden={welcome} />;
});
