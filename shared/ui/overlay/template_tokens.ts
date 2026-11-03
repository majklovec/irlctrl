/*
 * `{token}` template interpolation, shared by every element that renders
 * templated text (the alert element and the html_template element).
 *
 * A template is plain text with `{name}` tokens; each token resolves against
 * a project variable of that name first, then against a key of the trigger
 * payload (the alert endpoint's `?<name>=<value>` pairs). parseTemplate keeps
 * the token boundaries so renderers can accent the token segments;
 * templateText flattens them to plain text.
 *
 * Moved out of the alert element (elements/alerts.tsx, which re-exports it)
 * so the html_template module can resolve its title/subtitle without a
 * cross-module browser import.
 */

import type { ElementContext } from "@ui/overlay/element";

export interface TemplateSegment {
	text: string;
	/** true = a `{token}` segment (renders in the accent colour) */
	token: boolean;
}

/** Split a `{token}` template into plain/token segments (token boundaries
 * kept so the renderer can accent them; adjacent same-kind runs merge). */
export function parseTemplate(template: string): TemplateSegment[] {
	const segments: TemplateSegment[] = [];
	for (const match of template.matchAll(/([^{}]+)|\{([^{}]*)\}/g)) {
		const text = match[1] ?? match[2];
		const token = match[1] === undefined;
		if (!text) continue;
		const last = segments[segments.length - 1];
		if (last && last.token === token) last.text += text;
		else segments.push({ text, token });
	}
	return segments;
}

/** One token's value: a project variable of that name first, then a key of
 * the trigger payload; a missing value renders as "". */
export function tokenValue(
	name: string,
	ctx: ElementContext,
	payload: Record<string, unknown>,
): string {
	const variable = ctx.variableNames.get(name);
	if (variable !== undefined) return String(variable);
	const value = payload[name];
	if (value === undefined || value === null) return "";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** The template with tokens resolved to plain text (no markup). */
export function templateText(
	template: string,
	ctx: ElementContext,
	payload: Record<string, unknown>,
): string {
	return parseTemplate(template)
		.map((seg) => (seg.token ? tokenValue(seg.text, ctx, payload) : seg.text))
		.join("");
}
