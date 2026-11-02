/*
 * Design tokens: a colour literal may only appear as the value of a custom
 * property. The theme lives in shared/css/tokens.css; a module that needs a
 * colour of its own (a platform brand, a syntax palette, a role accent)
 * declares it as a variable in its own stylesheet and uses the variable.
 * Everything else reaches for the tokens, so a theme change is one edit.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CSS_ROOTS = ["shared/css", "client", "server"];
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules") return [];
        const path = join(dir, e.name);
        return e.isDirectory() ? walk(path) : path.endsWith(".css") ? [path] : [];
    });
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("css design tokens", () => {
    test("colour literals only appear as custom-property values", () => {
        const offenders: string[] = [];
        for (const root of CSS_ROOTS)
            for (const file of walk(join(ROOT, root))) {
                stripComments(readFileSync(file, "utf8"))
                    .split("\n")
                    .forEach((line, i) => {
                        // reset: /g + .test() is stateful and would skip the
                        // even-numbered line after a match
                        COLOR_LITERAL.lastIndex = 0;
                        if (!COLOR_LITERAL.test(line)) return;
                        // `--name: <value>;` declares a token — allowed anywhere
                        if (/^\s*--[\w-]+\s*:/.test(line)) return;
                        offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
                    });
            }
        expect(offenders).toEqual([]);
    });

    test("the theme is defined once, in shared/css/tokens.css", () => {
        const tokens = readFileSync(join(ROOT, "shared/css/tokens.css"), "utf8");
        for (const name of ["--accent", "--bg", "--text", "--muted", "--border", "--ok", "--warn", "--bad", "--radius", "--on-accent"])
            expect(tokens, `${name} missing`).toContain(`${name}:`);
        const style = readFileSync(join(ROOT, "shared/css/style.css"), "utf8");
        expect(style).toContain('@import "./tokens.css";');
        expect(style).not.toMatch(/^\s*--header-color\s*:/m);
    });
});
