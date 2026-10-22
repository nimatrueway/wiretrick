/**
 * One-time migration to the renamed script API and settings (see
 * shared/migration.ts for the rewrites). Runs on background start before
 * the pipeline loads scripts and before folder sync resumes; guarded by a
 * stored version so it runs once per profile.
 *
 * Stored script sources are rewritten through saveScript (recompiled, and
 * written to the synced folder by its normal reconcile). The originals are
 * kept in storage (MIGRATION_BACKUP_KEY) and — when a synced folder is set
 * up — saved to its .wiretrick-backup/ by folderSync before the files are
 * overwritten (PENDING_DISK_KEY), as is the old settings.yaml there.
 */
import { saveScript, type Script } from "./engine/scriptStore";
import { log } from "./engine/logs";
import { STRATEGY_KEY, SETTINGS_TEXT_KEY } from "./settingsFile";
import { storageGet, storageSet } from "../shared/chromeApi";
import { loadSavedHandle } from "../shared/folderSync";
import { dlogLevel } from "../shared/debugLog";
import { MIGRATION_VERSION, OLD_STRATEGIES, migrateScriptSource, migrateSettingsText } from "../shared/migration";

export const MIGRATION_KEY = "resMigrationVersion";
/** original sources of migrated scripts: { at, scripts: [{ id, name, code }] } */
export const MIGRATION_BACKUP_KEY = "resMigrationBackup";
/** work for folderSync's next start: { settings: boolean, scripts: [{ name, code }] } */
export const PENDING_DISK_KEY = "resMigrationPendingDisk";

export interface PendingDisk {
    settings: boolean;
    scripts: { name: string; code: string }[];
}

export async function runMigrations(): Promise<void> {
    const g = await storageGet([MIGRATION_KEY, "resScripts", STRATEGY_KEY, SETTINGS_TEXT_KEY]);
    if ((g[MIGRATION_KEY] ?? 0) >= MIGRATION_VERSION) return;
    const byId: Record<string, Script> = g.resScripts || {};
    const todo: { s: Script; code: string; changes: string[] }[] = [];
    for (const s of Object.values(byId)) {
        const m = migrateScriptSource(s.code);
        if (m.changes.length) todo.push({ s, code: m.code, changes: m.changes });
    }
    // originals first: a crash mid-way leaves them recoverable
    if (todo.length) await storageSet({ [MIGRATION_BACKUP_KEY]: { at: Date.now(), scripts: todo.map(({ s }) => ({ id: s.id, name: s.meta.name, code: s.code })) } });
    const synced = !!(await loadSavedHandle().catch(() => null));
    for (const { s, code, changes } of todo) {
        await saveScript({ id: s.id, code });
        log(-1, `[${s.meta.name}] migrated to the renamed script API: ${changes.join(", ")}`, "info", s.id);
    }
    const patch: Record<string, unknown> = { [MIGRATION_KEY]: MIGRATION_VERSION };
    const st = g[STRATEGY_KEY];
    if (typeof st === "string" && OLD_STRATEGIES[st]) {
        patch[STRATEGY_KEY] = OLD_STRATEGIES[st];
        log(-1, `settings: strategy "${st}" → defaultStrategy "${OLD_STRATEGIES[st]}"`, "info");
    }
    const text = g[SETTINGS_TEXT_KEY];
    if (typeof text === "string") {
        const next = migrateSettingsText(text);
        if (next !== text) patch[SETTINGS_TEXT_KEY] = next;
    }
    if (synced) patch[PENDING_DISK_KEY] = { settings: true, scripts: todo.map(({ s }) => ({ name: s.meta.name, code: s.code })) } satisfies PendingDisk;
    await storageSet(patch);
    if (todo.length) dlogLevel("bg", "info", `migration v${MIGRATION_VERSION}: ${todo.length} script(s) rewritten`);
}
