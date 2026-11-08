# Handoff Document: Move Language Selector to Profile and Introduce Multi-Project Architecture in IRLCTRL

## 1. Context and Goal

The repository `majklovec/irlctrl` is a Bun-based application for managing streaming devices. It consists of:
- **control server** (Bun + Elysia + SQLite + Mithril) — manages a fleet of devices from the browser.
- **device client** — runs on the device and communicates with the control server.

The goal of this task is to:
1. **Move the language selector** from the main menu into the Profile page to free up space in the main menu.
2. **Introduce projects** as a first-class entity:
   - Each user can have multiple projects.
   - Projects can be created, renamed, deleted, and shared.
   - Sharing is done via **invite links**.
   - Users in a project have roles (`owner`, `editor`, and optionally `viewer`).
3. **Add a project selector** to the main menu in the space freed by the language selector.

The expected result is an application where the active project is visible in the header and all data (dashboards, overlays, devices) is scoped to that project.

---

## 2. Current State of Relevant Parts

### 2.1 Main Menu and Profile

- The main menu is defined in `server/shell/nav.tsx`. It contains entries from the generated `MENUS` manifest and a **profile menu** (username, Profile, Logout).
- The profile page is in `server/shell/profile.tsx`. It loads `/api/profile`, manages passwords and device tokens, and for admins also includes an invitations panel.
- The language selector is likely in `shared/ui/components/language_select.tsx` (there is a `language_select.css`). It is currently placed in the main menu (not explicitly verified, but logically belongs with `nav.tsx`).

### 2.2 Authentication and Database

- Authentication is in `server/core/auth/auth.ts`. It uses SQLite (`bun:sqlite`) and the tables `users`, `tokens`, and `invitations`.
- The schema is managed by migrations in `server/core/migrations/`. The initial migration `0001_init.sql` creates `users`, `tokens`, `invitations`, and `dashboards`.
- There is already a specific `overlay_projects` table for OBS overlays, which stores a JSON blob and a token. This table should be **preserved**, but new general projects should have their own tables.

### 2.3 Modular Architecture

- Backend modules live in `client/modules/` (device) and `server/pages/` (control server). Each module has `backend.ts` and `frontend.tsx`.
- The new project module should respect this split. It is recommended to create `server/core/projects/` for backend logic (because projects are a cross-cutting entity) and place UI in `server/shell/` (project selector) and `server/shell/profile.tsx` (language selector).

### 2.4 Languages

- The list of supported languages is in `shared/languages.ts` (`LANGUAGE_INFO`).
- The i18n core is in `shared/i18n.ts`; the language is stored in `localStorage` or in user settings (in device mode via `settings.update`).

---

## 3. Proposed Data Model

Add a new migration in `server/core/migrations/` (for example `0004_projects.sql`) that creates:

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                -- UUID
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,          -- random hex, used in URL
  role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at DATETIME
);
```

**Notes:**
- `role` in `project_members` allows `owner`, `editor`, and `viewer`.
- There is always exactly one `owner`, and the owner is also recorded in `project_members` with the `owner` role.
- `project_invites` is separate from the existing `invitations` table (which is used for registering new users). The names are potentially confusing — use `project_invites`.

---

## 4. API Endpoints (Control Server)

All endpoints require an authenticated session (cookie) and return JSON.

### 4.1 Projects

| Method   | Path                | Description                                                             |
| -------- | ------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/api/projects`     | List projects where the user is a member. Returns `[{id, name, role}]`. |
| `POST`   | `/api/projects`     | Create a project. Body: `{name}`. The creator becomes `owner`.          |
| `PATCH`  | `/api/projects/:id` | Rename a project. Body: `{name}`. Only `owner` or `editor`.             |
| `DELETE` | `/api/projects/:id` | Delete a project. Only `owner`. Cascades to members and invites.        |

### 4.2 Member Management

| Method   | Path                                | Description                                                      |
| -------- | ----------------------------------- | ---------------------------------------------------------------- |
| `GET`    | `/api/projects/:id/members`         | List members `[{userId, login, role}]`.                          |
| `PATCH`  | `/api/projects/:id/members/:userId` | Change role. Body: `{role}`. Only `owner`.                       |
| `DELETE` | `/api/projects/:id/members/:userId` | Remove a member. Only `owner`; the last owner cannot be removed. |

### 4.3 Invite Links

| Method   | Path                                  | Description                                                                                                           |
| -------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/projects/:id/invites`           | Create an invite link. Body: `{role}` (`editor` or `viewer`). Returns `{token, url, expiresAt}`.                      |
| `GET`    | `/api/projects/:id/invites`           | List active invite links (only `owner`).                                                                              |
| `DELETE` | `/api/projects/:id/invites/:inviteId` | Revoke an invite link (only `owner`).                                                                                 |
| `GET`    | `/api/projects/join/:token`           | Preview a valid invite without consuming it. Returns `{project: {name}}`.                                             |
| `POST`   | `/api/projects/join/:token`           | Accept an invite. The authenticated user becomes a member. Returns `{project: {id, name, role}}`.                     |

**Recommendations for invite links:**
- Generate the token using `randomBytes(24).toString("hex")`.
- URL format: `https://<host>/projects/join/<token>` (or `/join?token=...`).
- Default expiry: 7 days; optionally `null` (no expiry).
- The invite role must not be higher than the creator's role (owner can create `editor` and `viewer`; editor can create only `viewer`).

---

## 5. UI Changes

### 5.1 Move Language Selector to Profile

- **Remove** the language selector from `nav.tsx` (if present there).
- **Add** the `LanguageSelect` component (existing `shared/ui/components/language_select.tsx`) to `profile.tsx` in a new “Language” section.
- After changing the language, call the existing i18n mechanism (`setLanguage` or equivalent) and optionally persist the choice to `localStorage` / user settings.

### 5.2 Project Selector in the Main Menu

- In `nav.tsx`, add a dropdown (or `<select>`) showing the user's projects.
- Load data from `GET /api/projects` during component initialization.
- Store the selected project in `localStorage` (key `activeProjectId`) or in the session.
- After changing the project, emit a global event (for example `window.dispatchEvent(new CustomEvent("project-changed", { detail: { projectId } }))`) so pages can re-render their data.
- If the user has no projects, show “Create project” and open a modal with a form.

### 5.3 Project Management Page

Create a new page module `server/pages/projects/` (or extend `profile.tsx`) with:
- a list of members and their roles,
- the ability to rename the project (owner/editor),
- the ability to delete the project (owner),
- a list of invite links with “Copy” and “Revoke” buttons,
- a form to create an invite link with role selection.

### 5.4 Data Scoping

All existing page modules (dashboards, devices, overlays) should be updated to filter by `project_id`. This means:
- add a `project_id` column to the relevant tables (or to JSON data),
- extend API endpoints with a `?projectId=...` query parameter,
- always send the active project from the UI.

**Alternative:** If you do not want to change all data immediately, you can initially introduce projects only as a “container” for new features and migrate gradually.

---

## 6. Implementation Plan (Step by Step)

1. **Database Migration**
   - Create `server/core/migrations/0004_projects.sql` with the tables above.
   - Run the migration at server startup (automatically via `openDatabase`).

2. **Backend — Project Module**
   - Create `server/core/projects/` with `projects.ts` (CRUD, membership, invite links).
   - Register routes in `server/core/app.ts` or in `server/core/auth/account_routes.ts`.
   - Add authorization: every endpoint must verify that the user is a project member with sufficient role.

3. **Backend — Update Existing Endpoints**
   - Add `project_id` to `dashboards`, `devices`, and `overlays` (migration `0005_add_project_scope.sql`).
   - Update handlers to require `projectId` and filter by it.

4. **Frontend — Move Language Selector**
   - Remove `LanguageSelect` from `nav.tsx`.
   - Add `LanguageSelect` to `profile.tsx` (section “Language”).

5. **Frontend — Project Selector**
   - Add a `ProjectSelector` component to `nav.tsx`.
   - Load `GET /api/projects`, store the selected project in `localStorage`.
   - Add a modal for creating a project.

6. **Frontend — Project Management**
   - Create a page module `server/pages/projects/` with UI for members, roles, and invite links.
   - Add a “Project settings” link to the profile menu or the project selector.

7. **Testing**
   - Write tests for backend endpoints (project creation, adding members, invite links, permissions).
   - Test UI scenarios: create project, switch project, accept invite link, change language in Profile.

---

## 7. Migration and Compatibility

- The existing `overlay_projects` table remains untouched; the new `projects` are general-purpose.
- If desired, `overlay_projects` can later be linked to `projects` via `project_id`, but this is not required.
- All new migrations must be **idempotent** (use `IF NOT EXISTS`) and never edit already-applied migrations.

---

## 8. Roles and Permissions (Summary)

| Action                                            | owner             | editor             | viewer         |
| ------------------------------------------------- | ----------------- | ------------------ | -------------- |
| Rename project                                    | ✅                | ✅                 | ❌             |
| Delete project                                    | ✅                | ❌                 | ❌             |
| Add/remove member                                 | ✅                | ❌                 | ❌             |
| Create invite link                                | ✅ (role ≤ owner) | ✅ (only `viewer`) | ❌             |
| Edit project content (dashboards, overlays, etc.) | ✅                | ✅                 | ❌ (read-only) |

---

## 9. Risks and Recommendations

- **Name collisions:** The existing `invitations` table is for registration; the new `project_invites` is separate. Do not confuse them.
- **Data scoping:** The largest amount of work is ensuring all existing data is tied to a project. Consider introducing projects first only for new features and migrating old data gradually.
- **Backward compatibility:** If some users have no project, create a default “Personal” project for them on first login.
- **Invite link security:** Tokens should be sufficiently long, have an expiry, and be single-use (or allow repeated use — decide based on requirements).

---

## 10. Key Files

| File                                            | Purpose                                    |
| ----------------------------------------------- | ------------------------------------------ |
| `server/shell/nav.tsx`                          | Main menu + profile dropdown               |
| `server/shell/profile.tsx`                      | Profile page (move language selector here) |
| `server/core/auth/auth.ts`                      | Authentication, users, tokens, invitations |
| `server/core/db.ts` + `server/core/migrations/` | Schema and migrations                      |
| `server/core/app.ts`                            | Server assembly and routes                 |
| `shared/languages.ts`                           | List of languages                          |
| `shared/ui/components/language_select.tsx`      | Existing language selector component       |
| `server/pages/`                                 | Page modules — add `projects` here         |

This document should provide sufficient context for another AI to implement the feature. It is recommended to proceed in small steps, always with tests and migrations.
