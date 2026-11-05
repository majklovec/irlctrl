# Widgets 

## 1. Context

**Target repository:** `https://github.com/majklovec/irlctrl`
**Target module:** `server/pages/overlays/modules/overlay_elements/`
**Task:** Reimplement the widgets found under `senchabot-opensource/monorepo/apps/extensions/src/features/widgets` as **native Mithril overlay elements** in irlctrl — **not** as iframe embeds.

---

## 2. irlctrl Overlay Element Architecture (Read First)

The overlay system separates **schemas** (environment‑free, used by the server for validation) from **element definitions** (browser‑side Mithril components).
- **Schema contract** lives in `server/core/overlay_element.ts`: `OverlayElementSchema` with `type`, `defaultProps`, `normalizeProps` (using `PropReaders` for safe coercion: `num`, `hex`, `str`, `oneOf`, `bool`).
- **Element definitions** live in `shared/ui/overlay/element.ts` (file not fully inspected, but the existing elements show the pattern). Each element exports an `OverlayElementDef` with:
  - `type`, `labelKey`, `icon`, `order`
  - `defaultProps`, `propKeys`, `defaultSize`, `handles`
  - `draw(element, ctx): Vnode`
  - `editForm({ element, mutate, variables }): Vnode`
  - `validate(element): string[]`
- **Registration** happens in `server/pages/overlays/modules/overlay_elements/overlay_elements.tsx`, which default‑exports an array of element definitions.
- **Existing reference implementations** to mirror:
  - `elements/iframe.tsx` — simple `drawIframe` delegation and minimal edit form.
  - `elements/video.tsx` — media playback props (`volume`, `muted`, `loop`, `autoplay`), defensive boolean reader, asset‑URL resolution via `ctx.assetUrls`.
  - `elements/alerts.tsx` — **most advanced example**: consumes runtime triggers (`triggerPhase`), project variables, and renders dynamic content with animations. Study this file to understand how an element can react to live data.
- **Schemas** are added to `overlay_schema.ts`, which already contains `VideoProps`, `IframeProps`, `AlertProps`, etc.

**Important:** The element `draw` function receives an `ElementContext` (`ctx`). The `alerts` element shows that `ctx` exposes runtime state (triggers, variables). Use the same mechanisms to feed live data to the reimplemented Senchabot widgets.

---

## 3. Senchabot Widgets to Port

The `features/widgets` directory contains these widgets (slugs from the GitHub tree listing). Their purposes are summarised from the official README and docs.

| Widget slug                           | Purpose                                                          | Likely data source                         |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `emote-wall`                          | Emote‑only messages float across screen (Calm/Chaos/Bounce).     | Chat events filtered for emotes.           |
| `emote-combo`                         | Combo counter for repeated emotes.                               | Chat events.                               |
| `alerts` / `stream-alerts`            | Animated alerts for subs, gift subs, bits, kicks, raids.         | EventSub / webhooks (Twitch), Kick events. |
| `sub-sprout`                          | Plant grows with each sub/resub/gift sub; resets at full growth. | Subscription events.                       |
| `subathon`                            | Subathon timer.                                                  | Subscription events + timer state.         |
| `goal` / `sub-goal` / `follower-goal` | Progress bar toward a target (subs, bits, follows).              | Aggregated event counts.                   |
| `countdown`                           | Starting‑soon / break / ending countdown.                        | Local timer, optional clock‑time target.   |
| `counter`                             | Up to four counters (wins, losses, etc.) changeable from chat.   | Chat commands + local state.               |
| `event-list`                          | Latest subs, gift subs, bits, kicks, raids from both chats.      | Event stream from Twitch/Kick.             |
| `credits`                             | Movie‑style credits for supporters, rolls on scene go‑live.      | Aggregated supporter data.                 |
| `leaderboard` / `top-supporters`      | Top gifters or cheerers, or latest supporter label.              | Event aggregation.                         |
| `lower-third`                         | Animated name + topic bar, lines take turns.                     | Static config, optional rotation.          |
| `featured`                            | Featured message (latest sub, cheer, etc.).                      | Latest event.                              |
| `frame`                               | Webcam/chat/screen frames (transparent centre).                  | Static config (colours, preset).           |
| `irl-hud`                             | Game‑style HUD: subs/bits/raids add cash, clock, mini‑map.       | Aggregated events + clock.                 |
| `weather`                             | Live weather card/pill from MET Norway.                          | HTTP fetch (no API key).                   |
| `now-playing`                         | Last.fm now‑playing card.                                        | Last.fm API.                               |
| `poll`                                | Chat poll.                                                       | Chat commands + local state.               |
| `queue`                               | Viewer queue.                                                    | Chat commands + local state.               |
| `raffle`                              | Raffle winner overlay.                                           | Chat commands + random selection.          |
| `spin-wheel`                          | Spin wheel.                                                      | Local state.                               |
| `tasks`                               | Task/quest list.                                                 | Static config.                             |
| `viewer-chat`                         | Simple viewer chat.                                              | Chat events.                               |
| `socials`                             | Social media handles, slide animation.                           | Static config.                             |

**Note:** The Senchabot widgets are designed to work **without a backend**; they read config from URL params and talk directly to Twitch/Kick from the browser. In irlctrl, however, you have the opportunity to centralise data fetching in the control server (if it already ingests chat/events) or to implement client‑side polling/WebSocket connections inside the element. **Prefer reusing irlctrl’s existing data channels** (as `alerts.tsx` does) over duplicating Senchabot’s network code.

---

## 4. Implementation Strategy

### 4.1. Start with a shared schema + per‑widget elements

Do **not** create one monolithic “senchabot” element. Create one element per widget, because each has a distinct prop set and edit form.
- Add a schema interface and `OverlayElementSchema` for each widget to `overlay_schema.ts`. Use the existing `PropReaders` (`num`, `hex`, `str`, `oneOf`, `bool`) to normalise props.
- Create one file per widget under `elements/` (e.g. `chat_widget.tsx`, `sub_sprout.tsx`, `emote_wall.tsx`, etc.). Each exports an `OverlayElementDef`.
- Register all new elements in `overlay_elements.tsx` by importing and appending them to the default export array.

### 4.2. Reuse irlctrl’s data layer

The `alerts` element demonstrates how an element can read live runtime state (`triggerPhase`, project variables). Before writing new networking code, investigate:
- Does `ElementContext` expose a runtime event bus, chat feed, or subscription aggregator?
- Are Twitch/Kick events already ingested by the control server for other features (e.g., dashboards, chat module)? If so, expose them via the same context.

If irlctrl does **not** already provide a unified event feed, implement a **thin shared client** (e.g. `lib/twitch_kick_client.ts`) that each widget can use. Do not copy Senchabot’s React hooks; write Mithril‑compatible subscriptions.

### 4.3. Rendering: Mithril, not React

All element `draw` functions return Mithril vnodes (`m(...)`). Senchabot widgets use React + Tailwind. You must **rewrite** the rendering layer in Mithril and reuse irlctrl’s CSS classes (`overlay-shape`, `overlay-video`, etc.) or add new ones. Do not import React or Tailwind.
- For animations (emote wall float, sub sprout growth, alerts), use CSS animations/transitions and Mithril lifecycle hooks (`oncreate`, `onupdate`, `onremove`). The `video` element shows how to manipulate the DOM in `oncreate`.
- For timers and intervals, use Mithril’s redraw cycle or `requestAnimationFrame` inside `oncreate`/`onremove`.

### 4.4. Config surfaces (edit forms)

Use `bindField` (as in `iframe.tsx` and `video.tsx`) to bind inputs to props. Each widget’s edit form should expose only the relevant props:
- **Chat‑based widgets:** channel name(s), platform (Twitch/Kick/both), emote provider toggles, theme colours.
- **Event‑based widgets:** event types, thresholds, reset behaviour, animation style.
- **Static widgets:** text, colours, font, layout.

### 4.5. Validation

Each element’s `validate` function should enforce required props (e.g. a channel name for chat widgets, a target for goals). Return a string array of problems, matching the pattern in `iframe.tsx`.

---

## 5. Files to Touch

| File                                                                                   | Action                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `server/pages/overlays/modules/overlay_elements/overlay_schema.ts`                     | Add prop interfaces + `OverlayElementSchema` for each widget. |
| `server/pages/overlays/modules/overlay_elements/elements/<widget>.tsx`                 | Create one file per widget (≈ 26 files).                      |
| `server/pages/overlays/modules/overlay_elements/overlay_elements.tsx`                  | Import and register all new elements.                         |
| `server/pages/overlays/modules/overlay_elements/i18n/en.json` (and other locale files) | Add labels, field labels, and placeholder messages.           |

No changes to the control server backend are required unless you choose to centralise data fetching there. The overlay element contract is frontend‑only.

---

## 6. Suggested Order of Work

1. **Infrastructure first:** Implement a shared `lib/` module for Twitch/Kick chat and event subscriptions (if not already present). Reuse irlctrl’s auth/session and avoid exposing secrets in the browser.
2. **Chat widgets:** `chat-widget`, `viewer-chat`, `emote-wall`, `emote-combo`, `event-list`, `featured`.
3. **Goal/alert widgets:** `alerts`, `stream-alerts`, `sub-sprout`, `subathon`, `goal`/`follower-goal`, `counter`.
4. **Utility widgets:** `countdown`, `weather`, `now-playing`, `poll`, `queue`, `raffle`, `spin-wheel`, `tasks`, `socials`, `credits`, `leaderboard`, `lower-third`, `frame`, `irl-hud`.

Start with a single widget (e.g. `weather`) to validate the pattern end‑to‑end, then scale.

---

## 7. Risks & Constraints

- **Real‑time data:** Chat and event widgets require persistent connections. Ensure connections are cleaned up in `onremove` to avoid leaks. Senchabot uses browser‑side connections; irlctrl may prefer server‑side aggregation. Decide early and document.
- **API limits & auth:** Twitch EventSub and Kick APIs may require OAuth tokens. Do not hardcode credentials. Use irlctrl’s existing token management if available.
- **Performance:** Emote wall and chat can produce high message volumes. Throttle updates and use Mithril’s redraw batching.
- **Mithril vs React:** Do not mix React components into irlctrl. Rewrite all UI in Mithril.
- **Styling:** irlctrl uses its own CSS system. Do not import Tailwind from Senchabot. Map designs to irlctrl CSS classes or add new scoped styles.
- **i18n parity:** The project enforces locale parity (see `AGENTS.md` for Senchabot and irlctrl conventions). Add all new keys to every locale file.
- **Licensing:** Senchabot is open‑source (check the licence). Reimplementing logic is generally fine, but copying large code blocks may carry attribution requirements. Document any direct reuse.

---

## 8. Acceptance Criteria

1. Typecheck and build pass (`bun`/`tsc` as per irlctrl’s toolchain).
2. Each widget appears in the overlay element picker with a real icon, label, and sensible default size.
3. Adding a widget to an overlay renders it without iframes or external browser‑source URLs.
4. Live data widgets (chat, alerts, goals) update in real time inside the overlay when events occur.
5. Config edits in the inspector immediately affect the rendered element.
6. `validate` produces errors for missing required fields.
7. No console errors on element creation, update, or removal.
8. Existing elements (`text`, `video`, `iframe`, `alerts`) continue to work unchanged.

---

## 9. References

- irlctrl module layout and overlay element registry: result 11
- Existing element patterns: `iframe.tsx`, `video.tsx`, `alerts.tsx`
- Schema contract: `server/core/overlay_element.ts`
- Senchabot widget directory: result 9
- Senchabot widget descriptions: result 4 and result 2
- Senchabot architecture (URL‑param config, no backend): result 5

---

## 10. Out of Scope

- Embedding Senchabot via `<iframe>` or browser‑source URLs.
- Porting Senchabot’s setup pages or dashboard.
- Implementing OAuth flows from scratch inside overlay elements (reuse irlctrl’s auth).
- Real‑time synchronisation between multiple overlays (unless irlctrl already provides it).

If a widget requires a data source that irlctrl does not currently expose, stop and flag it in the PR rather than inventing a new backend service without review.
