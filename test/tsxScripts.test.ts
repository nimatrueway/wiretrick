import { describe, it, expect } from "vitest";
import { isTsxName, scriptFileKey, scriptFileName, scriptNameFromFile, scriptNameFromInput, uniqueScriptName } from "../src/shared/scriptName";
import { dependantsOf, importResolver } from "../src/shared/scriptImports";
import { jsxElementAt } from "../src/shared/builtinSpecs";

// A script is .tsx by its name, as a file is by its extension: "ui/Panel.tsx"
// is ui/Panel.tsx on disk, where "ui/Panel" is ui/Panel.ts.

describe(".tsx script names", () => {
    it("keep their .tsx as the file name; other names get .ts", () => {
        expect(scriptFileName("ui/Panel.tsx")).toBe("ui/Panel.tsx");
        expect(scriptFileName("ui/Panel")).toBe("ui/Panel.ts");
        expect(scriptFileName(".tsx")).toBe(".tsx.ts");
        expect(scriptNameFromFile("ui/Panel.tsx")).toBe("ui/Panel.tsx");
        expect(scriptNameFromFile("ui/Panel.ts")).toBe("ui/Panel");
        expect(isTsxName("a/b.tsx")).toBe(true);
        expect(isTsxName("a/.tsx")).toBe(false);
        expect(scriptFileKey("Panel")).not.toBe(scriptFileKey("Panel.tsx"));
    });

    it("typed in a name box: .ts is dropped, .tsx kept", () => {
        expect(scriptNameFromInput("x.ts")).toBe("x");
        expect(scriptNameFromInput("x.tsx")).toBe("x.tsx");
        expect(scriptNameFromInput("x")).toBe("x");
    });

    it("a unique name numbers the stem, keeping .tsx", () => {
        expect(uniqueScriptName("Panel.tsx", ["Panel.tsx"])).toBe("Panel (2).tsx");
        expect(uniqueScriptName("Panel.tsx", ["Panel"])).toBe("Panel.tsx");
    });
});

describe("importing a .tsx script", () => {
    const resolve = importResolver(["ui/Panel.tsx", "My Widget.tsx", "both", "both.tsx"]);
    const name = (importer: string, spec: string) => {
        const r = resolve(importer, spec);
        return r?.kind === "script" ? r.name : r;
    };

    it("by its path with or without .tsx (or .js), as TypeScript resolves it", () => {
        expect(name("main", "./ui/Panel")).toBe("ui/Panel.tsx");
        expect(name("main", "./ui/Panel.tsx")).toBe("ui/Panel.tsx");
        expect(name("main", "./ui/Panel.js")).toBe("ui/Panel.tsx");
        expect(name("ui/x", "./panel")).toBe("ui/Panel.tsx");
        expect(name("main", "./My Widget")).toBe("My Widget.tsx");
        expect(name("main", "./my widget.tsx")).toBe("My Widget.tsx");
    });

    it("the .ts script wins over the .tsx one of the same path; .tsx names the .tsx", () => {
        expect(name("main", "./both")).toBe("both");
        expect(name("main", "./both.tsx")).toBe("both.tsx");
    });

    it("importers of a script renamed to .tsx still depend on it", () => {
        const scripts = [
            { id: "p", name: "Panel.tsx", code: "export const P = () => <div />;" },
            { id: "m", name: "main", code: 'import { P } from "./Panel";' },
        ];
        expect(dependantsOf("Panel.tsx", scripts)).toEqual(["m"]);
        expect(dependantsOf("Panel", scripts)).toEqual(["m"]);
    });
});

describe("jsxElementAt", () => {
    it("finds the first element's <", () => {
        expect(jsxElementAt("const a = 1;\nexport const P = () => <div>x</div>;")).toBe(36);
        expect(jsxElementAt("return <>hi</>")).toBe(7);
        expect(jsxElementAt("const b = a < c && d > e;")).toBe(-1);
    });
});
