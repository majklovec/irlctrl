/*
 * Page contracts — the only surface the control-server core knows.
 *
 * A page is a self-contained vertical slice under `server/pages/<id>/`:
 * server routes plus init (the only place services are received) and the
 * browser half (menu contribution + page components). The core never names
 * a page; discovery and composition run through core/registry.ts.
 *
 * Dependency rule (enforced by test/pages_boundaries.test.ts):
 *   pages/*  ->  shell/ -> ui (shared/ui) -> external
 *      \
 *       ->  core/ -> external
 * Cross-page state flows only through the capability map on PageServices —
 * one page never imports another, and the core stays entity-agnostic.
 */
import type { Database } from "bun:sqlite";
import type { Elysia } from "elysia";
import type { createAuth } from "./auth/auth";
import type { createFrontend } from "../../shared/frontend";

export type Auth = Awaited<ReturnType<typeof createAuth>>;
export type Frontend = Awaited<ReturnType<typeof createFrontend>>;
/** Push a message onto a WebSocket topic (Elysia publish, JSON-encoded). */
export type Publish = (topic: string, message: string) => void;

/** The control-server CLI configuration (flags / env vars preserved). */
export interface ServerConfig {
    hostname?: string;
    port: number;
    noAuth: boolean;
    databaseFile: string;
    /** Directory the asset files are stored on disk. */
    storageDir: string;
}

/**
 * The capability map: pages register string-keyed capabilities in their
 * `init` and later pages pull the ones they declare in `dependencies`.
 * The core stores them opaquely — it never names what a capability is.
 */
export interface CapabilityRegistry {
    provide(name: string, value: unknown): void;
    has(name: string): boolean;
    /** Throws if the capability is missing (the page's deps were not init'ed first). */
    require<T>(name: string): T;
}

/**
 * Everything a page may receive — and the only way it may get them.
 * `db` is null in `--no-auth` mode, exactly like today's stores.
 */
export interface PageServices {
    db: Database | null;
    auth: Auth;
    publish: Publish;
    config: ServerConfig;
    frontend: Frontend;
    capabilities: CapabilityRegistry;
}

/**
 * The authorization surface every project-scoped page pulls from the
 * "projects" capability (see core/app.ts). The projects store is the single
 * authority on membership + roles; entity stores take a `projectId` and scope
 * queries to it without doing auth themselves, so `requireRole` is the one
 * guard a handler must run before calling into an entity store.
 */
export type ProjectRole = "owner" | "editor" | "viewer";

export interface ProjectAccess {
    /** The user's role in the project, `null` when not a member (or no db). */
    role(user: string, projectId: string): ProjectRole | null;
    /**
     * The user's role in the project, throwing `ApiError` (404 for a missing
     * project / non-member, 403 for an insufficient role) — the guard an
     * entity route runs before dispatching to its store.
     */
    requireRole(
        user: string,
        projectId: string,
        allowed: readonly ProjectRole[],
    ): ProjectRole;
    /** Ensure + return the user's auto-created "Personal" project id. */
    personalProjectId(user: string): string;
}

/** A menu entry contributed by a page (rendered by the shell nav). */
export interface MenuContribution {
    /** Must equal the page directory name. */
    id: string;
    /** i18n key of the visible label (the shell renders it through t()). */
    labelKey: string;
    /** The page's primary URL, e.g. "/devices/". */
    path: string;
    /** Menu ordering; smaller first (default 100). */
    order?: number;
}

export interface PageModule {
    id: string;
    /** ids of pages whose capabilities this page's `init` consumes; init runs after them */
    dependencies?: string[];
    menu: MenuContribution;
    backend: {
        /** Elysia plugin mounted by the core; owns the page's routes and WS. */
        routes: Elysia;
        /** Receive the shared services once, before the routes are mounted. */
        init?: (s: PageServices) => void | Promise<void>;
        /** Called once the app is listening: page-local maintenance timers. */
        start?: (s: PageServices) => void | Promise<void>;
    };
    frontend: {
        /**
         * The HTML entry names this slice serves (pages/*.html). The browser
         * components themselves are referenced only by the generated browser
         * manifest, so the server process never loads frontend code.
         */
        pages: string[];
    };
}
