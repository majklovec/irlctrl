/*
 * Backend file helpers.
 */
import { randomBytes } from "node:crypto";
import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replace `path` atomically: write a fresh sibling file, then rename it over the target.
 *
 * Opening an existing file for writing in a sticky world-writable directory such as /tmp fails
 * with EACCES when it belongs to another user (fs.protected_regular), even for root — e.g. files
 * left by an earlier non-root run. Replacing via rename avoids that, and readers reloading on
 * SIGHUP never see a half-written file.
 */
export async function writeFileAtomic(
    path: string,
    data: string,
): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(tmp, data, { flag: "wx" });
        await rename(tmp, path);
    } catch (err: unknown) {
        await unlink(tmp).catch(() => {});
        throw err;
    }
}

/**
 * Remove leftover `<path>.<hex>.tmp` files. A save renames its temp file into
 * place, so any `.tmp` sibling is a stale artifact of a process that was
 * killed (crash / force-quit / OOM) between the write and the rename. These
 * accumulate across runs — a fresh boot is the safe point to clear them, since
 * no other process is mid-save for a config a single device owns.
 */
export async function removeStaleTmps(path: string): Promise<void> {
    const dir = dirname(path);
    const prefix = `${basename(path)}`;
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const name of files) {
        if (
            name.startsWith(prefix + ".") &&
            name.endsWith(".tmp") &&
            name !== basename(path)
        ) {
            await unlink(join(dir, name)).catch(() => {});
        }
    }
}
