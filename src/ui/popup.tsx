import { createRoot } from "react-dom/client";
import { Popup } from "./popup/Popup";
import { chromePopupApi } from "./popup/api";
import { watchTheme } from "./theme";
import { installTooltips } from "./tooltip";

watchTheme();
installTooltips();
createRoot(document.getElementById("root")!).render(<Popup api={chromePopupApi} />);
