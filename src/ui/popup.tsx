import { render } from "preact";
import { Popup } from "./popup/Popup";
import { chromePopupApi } from "./popup/api";
import { watchTheme } from "./theme";
import { installTooltips } from "./tooltip";

watchTheme();
installTooltips();
render(<Popup api={chromePopupApi} />, document.getElementById("root")!);
