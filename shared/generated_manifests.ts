/*
 * The build-time manifests under generated/ (module registries, overlay
 * element schemas, i18n catalogs, version) are gitignored. A compiled binary
 * carries them; a source run (`bun …/server.ts`, Docker, a fresh clone)
 * regenerates them here, before anything that statically imports them is
 * loaded — so the entrypoints call this first and dynamically import the
 * rest.
 */
import { appPath } from "./paths";
import { isCompiledBinary } from "./util";

export async function ensureGeneratedManifests(): Promise<void> {
	if (isCompiledBinary()) return;
	await Bun.$`bun ${appPath("scripts/gen_modules.ts")}`.quiet();
}
