import { createRoot } from "react-dom/client";
import { InstallPage } from "./install/InstallPage";
import { watchTheme } from "./theme";

watchTheme();
document.title = "Install a script — Wiretrick";
createRoot(document.getElementById("root")!).render(<InstallPage />);
