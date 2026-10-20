import { render } from "preact";
import { Popup } from "./popup/Popup";
import { chromePopupApi } from "./popup/api";

render(<Popup api={chromePopupApi} />, document.getElementById("root")!);
