/** Chat message decoration: escaped HTML with linked URLs and bold @mentions. */

/** A message starting with @username is a DM — render it muted. */
export const DM_RE = /^\s*@[A-Za-z0-9_-]+/;

export function decorateText(text: string): string {
	const escapeHtml = (str: string): string =>
		str.replace(/[&<>"']/g, (ch) => {
			const map: Record<string, string> = {
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#039;",
			};
			return map[ch];
		});

	const urlRegex = /((?:https?:\/\/|www\.)[^\s]+)/gi;
	// @mentions in bold; only at text start or after whitespace, so
	// e-mail-style "user@domain" runs are left untouched.
	const mentionRegex = /(^|\s)@([A-Za-z0-9_-]+)/g;

	// A DM line: the whole leading text run (everything before the first URL)
	// is wrapped in a span the page can dim.
	const dm = DM_RE.test(text);

	return text
		.split(urlRegex)
		.map((part: string, index: number): string => {
			if (!/^(?:https?:\/\/|www\.)/i.test(part)) {
				const out = escapeHtml(part).replace(mentionRegex, "$1<b>@$2</b>");
				return dm && index === 0 && out
					? `<span class="dm">${out}</span>`
					: out;
			}

			let url = part;
			let trailing = "";

			const trailingMatch = url.match(/[.,!?;:)\]}'"]+$/);
			if (trailingMatch) {
				trailing = trailingMatch[0];
				url = url.slice(0, -trailing.length);
			}

			const href = /^www\./i.test(url) ? `http://${url}` : url;

			return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
		})
		.join("");
}
