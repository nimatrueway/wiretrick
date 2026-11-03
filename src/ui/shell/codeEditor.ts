/**
 * The Code view's Monaco editor. React renders its host element
 * (<MonacoHost>) once; the editor itself is created here, after Monaco has
 * loaded, and never goes into a store.
 */
let host: HTMLElement | null = null;
let editor: any = null;

export function attachHost(el: HTMLElement): () => void {
    host = el;
    return () => {
        editor?.dispose();
        editor = null;
        host = null;
    };
}

/** Create the editor in the mounted host (Monaco must be loaded). */
export function createCodeEditor(options: Record<string, unknown>): any {
    if (!host) throw new Error("the Monaco host is not mounted");
    editor = (window as any).monaco.editor.create(host, options);
    return editor;
}

export const codeEditor = (): any => editor;
