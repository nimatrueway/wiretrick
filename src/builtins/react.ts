/**
 * The built-in React chunk (`builtins-react.js`): the extension's own
 * React 19 for scripts that import it. Loaded with a <script> tag only
 * when a script imports React (src/shared/builtins.ts).
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import * as JsxDevRuntime from "react/jsx-dev-runtime";

(globalThis as any).__ttBuiltinReact = {
    react: React,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "react/jsx-runtime": JsxRuntime,
    "react/jsx-dev-runtime": JsxDevRuntime,
};
