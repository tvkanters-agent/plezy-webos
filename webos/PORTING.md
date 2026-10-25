# Plezy webOS porting contract

The `webos/` app is a **port of Plezy**, not a new TV client design. Original Flutter code in this repository is the specification.

## Mandatory workflow for every change

1. Read the matching original Flutter component, controller, model, service and **tests** before editing the webOS implementation.
2. Translate **the same behavior, hierarchy, copy, data, options, keyboard/remote navigation and visual tokens**. Reuse existing assets and identifiers; do not invent replacements when an upstream solution exists.
3. Keep features aligned: use Plex data from the same API paths and reproduce its loading, errors, and success states.
4. Isolate and document any unavoidable webOS 4.4/Chromium 53 adaptation (native Flutter/MPV APIs, video pipeline, browser fetch/CORS limits). The adaptation must be as narrow as possible, not a new feature design.
5. Write tests based on upstream acceptance cases, comparing exact request bodies, screen semantics, and focus transitions. Do not change tests merely to make a different implementation pass.
6. Commit related changes together with descriptive messages. Apply any agent-specific commit labels only when instructed for that agent's work. Test and identify failed/untested parity honestly.

**Never introduce speculative matching, fallback endpoints, UI controls, labels or new layouts in place of an existing upstream implementation.** New solutions require a demonstrated incompatibility, written justification, and tests.

## Source map

| WebOS area | Authoritative Flutter source |
|---|---|
| Simkl OAuth device linking, refresh, error handling | `lib/services/trackers/simkl/simkl_auth_service.dart`, `simkl_client.dart`, `simkl_constants.dart`, `test/services/trackers/simkl_*_test.dart` |
| Simkl scrobble and watched history | `lib/services/trackers/simkl/simkl_tracker.dart`, `lib/services/trackers/tracker_history_body.dart`, `lib/models/trackers/tracker_context.dart`, `test/services/trackers/simkl_scrobble_test.dart` |
| External Plex IDs | `lib/services/trackers/tracker_id_resolver.dart`, `lib/utils/external_ids.dart`, `test/services/plex_external_ids_fetch_test.dart` |
| Sidebar library navigation | `lib/widgets/tv_browse_rail.dart`, `lib/widgets/side_navigation_rail.dart`, `lib/screens/main_screen.dart` |
| Library browsing, collections and recommendation tabs | `lib/screens/libraries/`, `lib/screens/libraries/tabs/library_browse_tab.dart` |
| Movie/show/season/episode detail pages | `lib/screens/media_detail_screen.dart` and its imported widgets |
| D-pad focus, cards and scrolling | `lib/focus/focus_theme.dart`, `lib/widgets/focusable_media_card.dart`, `lib/widgets/horizontal_scroll_with_arrows.dart` |
| Player transport, chapter and track controls | `lib/widgets/video_controls/desktop_video_controls.dart`, `lib/widgets/video_controls/widgets/`, `lib/screens/video_player/` |
| Colors, shapes and typography | `lib/theme/mono_tokens.dart`, `lib/theme/mono_theme.dart` |

These are pointers, not claims of completed porting. The current HTML frontend still has parity gaps and must not be described as faithful merely because a similarly named feature exists.

## Simkl-specific parity decision

Upstream `SimklTracker._scrobbleBody` sends:
- Movie: `{ "progress": 20.5, "movie": { "ids": { "imdb": "tt123" } } }`
- Episode: `{ "progress": 20.5, "show": { "ids": { "tvdb": 123 } }, "episode": { "season": 1, "number": 3 } }`

The ID resolver uses Plex Movie/TV Series `Guid` arrays and legacy `com.plexapp.agents.*` scalar GUIDs, following `ExternalIds.fromGuids`, `fromLegacyPlexGuid`, and `fillFrom`; for episodes, use **show-level** GUIDs. If none are available, upstream sends **nothing**—no title/year matching or Simkl catalog search. Only `start`, `pause`, `stop` are transmitted. Simkl determines watched at 80% on `stop`. Manual watched state uses ID-only `/sync/history` with nested show/season/episode structure.

**Documented webOS-only exception:** The current webOS OAuth calls serialize device/token grant fields as JSON rather than Dart's form-encoded `bodyFields`, because the actual LG test returned `HTTP 400 invalid_request: Invalid JSON request` for form-encoded bodies and connected after JSON was implemented. Retain the same upstream field names, scope, bare OAuth URLs and polling logic; do not generalize this transport difference to unrelated flows.

All Plex/player work should follow the same upstream-first rule; when something cannot be translated verbatim, explain the technical limitation instead of substituting new behavior.
