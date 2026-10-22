import { Buffer } from "node:buffer";
import { isCompiledBinary } from "../util";
import { PAGES, type PageName } from "./pages";

export type { PageName } from "./pages";

export async function createFrontend(publicDirectory: URL) {
    const pages = {} as Record<PageName, string>;
    const assets = new Map<string, Blob>();

    if (isCompiledBinary()) {
        const { default: embedded } = await import(
            "./.generated.frontend-assets"
        );
        for (const page of PAGES) pages[page] = embedded.pages[page];
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
        const result = await Bun.build({
            entrypoints: PAGES.map(
                (name) => new URL(`${name}.html`, publicDirectory).pathname,
            ),
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
            const page = PAGES.find(
                (name) => file.startsWith(`${name}-`) && file.endsWith(".html"),
            );
            if (page) pages[page] = await out.text();
            else assets.set(file, out);
        }
    }

    const htmlResponse = (page: PageName) =>
        new Response(pages[page], {
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-cache",
            },
        });

    return { assets, htmlResponse };
}
