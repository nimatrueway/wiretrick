import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// synchronously, before editor.ts looks anything up by id
flushSync(() => createRoot(document.getElementById("root")!).render(<App />));
