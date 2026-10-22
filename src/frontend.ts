import { Buffer } from "node:buffer";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary } from "./util";
import { PAGES } from "./control-server/pages";

export interface FrontendPageEntry {
    name: string;
    path: string;
}

export function frontendPageEntries(publicDirectory: URL): FrontendPageEntry[] {
    const entries: FrontendPageEntry[] = PAGES.map((name) => ({
        name,
        path: new URL(`${name}.html`, publicDirectory).pathname,
    }));
    const modulesDirectory = fileURLToPath(
        new URL("../modules/", import.meta.url),
    );

    for (const module of readdirSync(modulesDirectory, {
        withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!module.isDirectory()) continue;
        const pagesDirectory = join(modulesDirectory, module.name, "pages");
        let pages;
        try {
            pages = readdirSync(pagesDirectory, {
                withFileTypes: true,
            }).sort((left, right) => left.name.localeCompare(right.name));
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
            )
                continue;
            throw error;
        }
        for (const page of pages) {
            if (!page.isFile() || !page.name.endsWith(".html")) continue;
            entries.push({
                name: page.name.slice(0, -".html".length),
                path: join(pagesDirectory, page.name),
            });
        }
    }

    const names = new Set<string>();
    for (const entry of entries) {
        if (names.has(entry.name))
            throw new Error(`Duplicate frontend page: ${entry.name}`);
        names.add(entry.name);
    }
    return entries;
}

export async function createFrontend(publicDirectory: URL) {
    const pages: Record<string, string> = {};
    const assets = new Map<string, Blob>();

    if (isCompiledBinary()) {
        const { default: embedded } = await import(
            "./control-server/.generated.frontend-assets"
        );
        Object.assign(pages, embedded.pages);
        for (const [file, asset] of Object.entries(embedded.assets)) {
            assets.set(
                file,
                new Blob([Buffer.from(asset.base64, "base64")], {
                    type: asset.type,
                }),
            );
        }
    } else {
        await Bun.$`bun scripts/gen-modules.ts`.quiet();
        const entries = frontendPageEntries(publicDirectory);
        const result = await Bun.build({
            entrypoints: entries.map((entry) => entry.path),
            target: "browser",
            minify: true,
            splitting: true,
            publicPath: "/assets/",
            naming: {
                asset: "[name]-[hash].[ext]",
                chunk: "[name]-[hash].[ext]",
                entry: "[name]-[hash].[ext]",
            },
        });
        if (!result.success) {
            for (const log of result.logs) console.error(log);
            throw new Error("Failed to bundle the web UI");
        }
        for (const out of result.outputs) {
            const file = out.path.replace(/^\.\//, "");
            const page = entries.find(
                ({ name }) =>
                    file.startsWith(`${name}-`) && file.endsWith(".html"),
            );
            if (page) pages[page.name] = await out.text();
            else assets.set(file, out);
        }
        for (const { name } of entries)
            if (!pages[name])
                throw new Error(`The frontend build omitted ${name}.html`);
    }

    const htmlResponse = (page: string) => {
        const html = pages[page];
        if (!html) throw new Error(`Unknown frontend page: ${page}`);
        return new Response(html, {
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-cache",
            },
        });
    };

    return { assets, htmlResponse };
}
