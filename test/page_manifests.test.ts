import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

for (const separator of ["/", "\\"]) {
    test(`page manifests resolve imports with ${JSON.stringify(separator)} scan separators`, async () => {
        const tree = mkdtempSync(join(tmpdir(), "irlctrl-page-manifests-"));
        try {
            for (const dir of ["scripts", "shared"])
                mkdirSync(join(tree, dir), { recursive: true });
            copyFileSync(
                join(projectRoot, "scripts/gen_pages.ts"),
                join(tree, "scripts/gen_pages.ts"),
            );
            copyFileSync(
                join(projectRoot, "shared/paths.ts"),
                join(tree, "shared/paths.ts"),
            );
            for (const page of ["templates", "assets"]) {
                const dir = join(tree, "server/pages", page);
                mkdirSync(join(dir, "frontend"), { recursive: true });
                writeFileSync(join(dir, "frontend/menu.ts"), "export default {};\n");
                writeFileSync(join(dir, "index.ts"), "export default {};\n");
            }
            // Exercise the real generator with either platform's Glob output.
            writeFileSync(
                join(tree, "scan-separators.ts"),
                `const scan = Bun.Glob.prototype.scan;
Bun.Glob.prototype.scan = async function* (options) {
    for await (const path of scan.call(this, options))
        yield path.replaceAll("\\\\", "/").replaceAll("/", ${JSON.stringify(separator)});
};
`,
            );
            const generated = Bun.spawnSync(
                [process.execPath, "--preload", "./scan-separators.ts", "scripts/gen_pages.ts"],
                { cwd: tree, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
            );
            expect(generated.exitCode, generated.stderr.toString()).toBe(0);

            const result = await Bun.build({
                entrypoints: [
                    join(tree, "generated/pages.ts"),
                    join(tree, "generated/pages.server.ts"),
                ],
                target: "browser",
            });
            expect(result.success, result.logs.map(String).join("\n")).toBe(true);

            for (const [file, variable, suffix, exported] of [
                ["pages.ts", "menu", "frontend/menu", "MENUS"],
                ["pages.server.ts", "page", "index", "PAGE_MODULES"],
            ]) {
                const source = readFileSync(join(tree, "generated", file), "utf8");
                expect(source).not.toContain("\\");
                expect(source).toContain(
                    `import ${variable}0 from "../server/pages/assets/${suffix}";`,
                );
                expect(source).toContain(
                    `import ${variable}1 from "../server/pages/templates/${suffix}";`,
                );
                expect(source).toContain(
                    `export const ${exported} = [${variable}0, ${variable}1];`,
                );
            }
        } finally {
            rmSync(tree, { recursive: true, force: true });
        }
    });
}
