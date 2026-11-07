import { useSnapshot } from "valtio";
import { InstallFlow, type InstallHost } from "../install/InstallPage";
import { useInstallDrop } from "../install/drop";
import { actions } from "../shell/actions";
import { dialogs, openInstall } from "../state/dialogs";
import { explorer } from "../state/explorer";
import { Overlay } from "./controls";

const close = (): void => void (dialogs.install = null);

const host: InstallHost = {
    embedded: true,
    close,
    async openEditor(id) {
        close();
        // the Explorer lists the new script once its storage change arrives
        for (let i = 0; i < 50 && !explorer.scripts.some((s) => s.id === id); i++) await new Promise((r) => setTimeout(r, 100));
        actions.select(id);
        actions.focusEditor();
    },
};

/** Install Script…: the install flow (install/InstallPage) as a dialog; a drop anywhere on it starts over with what was dropped. */
export function InstallDialog() {
    const { install } = useSnapshot(dialogs);
    const { over, handlers } = useInstallDrop((drop) => openInstall({ drop }));
    if (!install) return null;
    return (
        <Overlay id="install-dialog" open onClose={close} extra={handlers}>
            <div className={"dialog wide install-dialog" + (over ? " dropping" : "")} role="dialog" aria-modal="true" aria-labelledby="install-dialog-title">
                <div className="dialog-head">
                    <h2 id="install-dialog-title">{install.req.update ? "Review Update" : "Install Script"}</h2>
                    <button className="btn-close" data-close="" title="Close (Esc)">
                        ✕
                    </button>
                </div>
                <InstallFlow key={install.n} request={install.req} host={host} />
            </div>
        </Overlay>
    );
}
