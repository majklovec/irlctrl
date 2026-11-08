/** @jsx m */
/*
 * The main-menu project selector (TODO/01-projects.md): a dropdown of the
 * session user's projects. The choice persists in localStorage
 * (`activeProjectId`) and every change is broadcast as the global
 * `project-changed` CustomEvent so the open pages can rescope. It is purely a
 * switcher — projects are created on the Projects page, not here — and it
 * hides itself when the user has none.
 *
 * Shell-owned: it talks to the API over HTTP only (the shell never imports
 * page code — the projects page just consumes the same storage key).
 */
import { apiJson } from "@ui/api_client";
import { t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
import m from "mithril";
import "./project_select.css";

/** The localStorage key of the active project id. */
export const ACTIVE_PROJECT_KEY = "activeProjectId";
/** The global event an active-project change is broadcast as. */
export const PROJECT_CHANGED_EVENT = "project-changed";

interface Project {
	id: string;
	name: string;
	role: "owner" | "editor" | "viewer";
}

const state = {
	projects: null as Project[] | null, // null = before the first load
	active: null as string | null,
};

/** The active project id (the persisted choice), `null` when none. */
export function getActiveProjectId(): string | null {
	try {
		return localStorage.getItem(ACTIVE_PROJECT_KEY);
	} catch {
		return null;
	}
}

/** Persist the choice and broadcast it. `null` clears the selection. */
export function setActiveProjectId(id: string | null): void {
	try {
		if (id === null) localStorage.removeItem(ACTIVE_PROJECT_KEY);
		else localStorage.setItem(ACTIVE_PROJECT_KEY, id);
	} catch {
		// The storage is best effort (private mode): the event still goes out.
	}
	state.active = id;
	window.dispatchEvent(
		new CustomEvent(PROJECT_CHANGED_EVENT, { detail: { projectId: id } }),
	);
	m.redraw();
}

function select(id: string): void {
	if (id === state.active) return;
	setActiveProjectId(id);
}

async function load(): Promise<void> {
	try {
		const body = await apiJson<{ projects: Project[] }>("/api/projects");
		state.projects = body.projects;
		const saved = getActiveProjectId();
		const fresh = body.projects.find((p) => p.id === saved);
		// The saved id must still exist; otherwise fall back to the first
		// project (a new user's first visit selects their first project).
		if (fresh) state.active = fresh.id;
		else setActiveProjectId(body.projects[0]?.id ?? null);
		m.redraw();
	} catch {
		// `--no-auth` mode (503) or a network failure: hide the selector.
		if (state.projects === null) state.projects = [];
		m.redraw();
	}
}

/** The selector shows only once the API answered and the user has projects —
 * projects are created on the Projects page, not from the main menu. */
function visible(): boolean {
	return state.projects !== null && state.projects.length > 0;
}

const ProjectSelectComponent: m.Component = {
	oncreate() {
		void load();
	},
	view: () =>
		!visible() ? null : (
			<select
				class="project-select"
				aria-label={t("projects.select.label")}
				value={state.active ?? ""}
				onchange={(e: Event) =>
					select((e.target as HTMLSelectElement).value)
				}
			>
				{state.projects!.map((p) => (
					<option key={p.id} value={p.id}>
						{p.name}
					</option>
				))}
			</select>
		),
};

export const ProjectSelect = ProjectSelectComponent as MithrilJSXComponent;
