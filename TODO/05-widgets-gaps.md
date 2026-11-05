# 05 — Widgets: what was implemented and what is deliberately deferred

Companion to [05-widgets.md](./05-widgets.md). The overlay element system
(`server/pages/overlays/modules/overlay_elements/`) now ships the widgets that
can be served from data the app already has. The remaining widgets need
capabilities that don't exist yet in irlctrl; this doc lists them and what each
one is blocked on, so the list can be picked up in a follow-up.

## Implemented (15 new elements)

| Element | id | Data source | Notes |
| --- | --- | --- | --- |
| Weather | `weather` | MET Norway REST (direct `fetch`) | Reverse-geocoded `location.text` lookup; interval refresh |
| Now playing | `now_playing` | Last.fm `user.getRecentTracks` | Needs a user-pasted free Last.fm API key + username in props |
| Countdown | `countdown` | wall clock | `clock` (daily HH:MM), `duration` (anchored at first draw), `loop` (re-anchors per period) |
| Lower thirds | `lower_third` | static props | Rotating title/subtitle rows, interval in ms |
| Frame | `frame` | static | Border + optional corner label |
| Socials | `socials` | static | Link chips, optional slide/interval rotation |
| Credits | `credits` | static | Scrolling list; duration derived from `speed` |
| Tasks | `tasks` | static | Checklist rows with `done` toggle |
| Goal | `goal` | static / bindable scalars | Progress bar, `value` + `target` bindable |
| Counter | `counter` | static / bindable | Up to 4 stat tiles, row/column layout |
| Spin wheel | `spin_wheel` | trigger | `onTrigger`: matching event spins the wheel (CSS transition) and lands on a prize |
| Emote wall | `emote_wall` | live chat | Every message spawns a floating chip that drifts up (`ovEmoteFloat`); motion presets |
| Emote combo | `emote_combo` | live chat | Streak detector per channel: same text within `windowSec` shows `×N text`, decays after |
| Featured | `featured` | live chat | Latest message/user card from the feed tail |
| Viewer chat | `viewer_chat` | live chat | Last N chat lines, top/bottom order, sender colours |

Chat-driven widgets depend on the live-chat hub: the backend
`runtimeOverlayChatSpecs` (`server/pages/overlays/backend/registry.ts`) now
scans **all** chat-carrying elements (`chat`, `emote_wall`, `emote_combo`,
`featured`, `viewer_chat`) — not just `chat` — and opens provider sockets for
the union of their channels. Before that change, only the dedicated `chat`
element got a live feed.

## Deferred — no data source yet

These have no feed in irlctrl today (no bits/spends/subs/raids event pipeline,
no chat-command parser, no poll/queue storage). They need one of the listed
prerequisites, so they were not stubbed out.

| Widget | Blocked on |
| --- | --- |
| Event list | a persistent event/todo store the streamer can edit (no CRUD backend for events) |
| Leaderboard (chat activity) | per-chat message counters aggregated server-side (the hub is fire-and-forget; nothing is counted) |
| Top supporters | bits/spends revenue feed (no donation provider integration) |
| Sub sprout | sub event feed (no provider sub-event socket) |
| Subathon | sub goal + duration tracking with milestone states |
| IRL HUD (HP/stamina etc.) | a live mutable state model + command/trigger writes |
| Poll | poll storage + vote capture (chat-command or button based) + result aggregation |
| Queue | a queue store (e.g. song requests) with pop on streamer action |
| Raffle | entry capture (chat command) + winner pickup + prize config |

Not a gap: **stream alerts** (subs/cheers/goals/raids) are covered by the
existing `alert` element + the trigger system — providers push events through
the same hub, so a dedicated "alert list" widget is redundant.

## Smaller caveats

- `now_playing` needs a personal Last.fm API key pasted into props (free, 5 s
  call budget). No server-side proxy, so the key is visible in overlay URL
  state on the streamer's machine only.
- Weather uses MET Norway (free, no key, 10-min cache upstream). Cities
  outside their coverage area will not resolve.
- Chat-driven widgets show their **design state** in the editor and come alive
  on a started page (the feed only connects when `ctx.activeTriggers` is set) —
  same liveness rule as the `chat` element.
