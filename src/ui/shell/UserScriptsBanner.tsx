import { useSnapshot } from "valtio";
import { userScriptsHowTo } from "../../shared/userScriptsStatus";
import { bannerShown, dismissUserScriptsBanner, requestUserScripts, userScriptsBanner } from "../state/userScripts";

/** Chrome MV3: isolated onPage code needs user scripts — say how to turn them on */
export function UserScriptsBanner() {
    const s = useSnapshot(userScriptsBanner);
    if (!bannerShown(s) || s.status === "ok") return null;
    const settings = `chrome://extensions/?id=${s.extensionId}`;
    return (
        <div id="userscripts-banner" className="wt-banner" role="status" data-status={s.status}>
            <span className="wt-banner-text">
                <b>User scripts are off:</b> onPage code doesn't run (except <code>world: "page"</code>). To run it, {userScriptsHowTo(s.status, s.extensionId)}.
            </span>
            {s.status === "no-permission" ? (
                <button id="userscripts-grant" onClick={() => requestUserScripts()}>
                    Grant permission
                </button>
            ) : (
                <button id="userscripts-open" onClick={() => chrome.tabs.create({ url: settings }, () => void chrome.runtime.lastError)}>
                    Open extension details
                </button>
            )}
            <button className="wt-banner-close" title="Dismiss (the Problems error stays until user scripts are on)" aria-label="Dismiss" onClick={() => dismissUserScriptsBanner()}>
                ✕
            </button>
        </div>
    );
}
