/**
 * Dirty-state computation for the manager editor: a file is dirty when its
 * content differs from the last-saved baseline OR its name differs from the
 * stored one — and reverting either to the exact stored value clears it
 * (no "Discard unsaved changes?" prompt on a no-op edit).
 */
export function computeDirty(
    content: string,
    /** last-saved content of the open file; null = unknown model (treat as dirty) */
    baseline: string | null,
    /** current name-input value; undefined = name not editable (settings view) */
    name: string | undefined,
    /** stored script name; undefined = none to compare against */
    storedName: string | undefined
): boolean {
    const contentDirty = baseline === null || content !== baseline;
    const nameDirty = storedName !== undefined && name !== undefined && name !== storedName;
    return contentDirty || nameDirty;
}
