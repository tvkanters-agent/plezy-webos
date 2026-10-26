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

### Repair of persisted webOS Simkl stops

The pre-fix webOS queue replayed an old stop before each new start/pause. A title-only row returning `404 id_err` threw out of that replay and cancelled the **new** viewing's event, even when its Plex IDs were valid. Native `TrackerWriteQueue._flushOnce` handles item failures independently. Keep that isolation in the browser queue; account/rate cooldowns still apply to the whole service.

On upgrade, old saved stops with empty IDs are skipped and removed without a network request, matching native Simkl's no-ID guard. They cannot be resolved retroactively because those rows contain no Plex rating key. New viewings fetch movie/show IDs via `PlexClient.fetchExternalIds`' exact metadata query. Old ID-bearing stops remain retryable, but title/year fields are stripped before transmission. `SimklTracker.needsFribb` is false upstream, so the standalone Simkl integration must not fetch or apply Fribb mappings.

### Simkl community scores: native HTTP transport

The original `SimklCatalogSource.fetchCommunityRatings` uses the connected account
on `GET /redirect?to=simkl&…`, reads the unfollowed Location, then requests
`/{movies|tv|anime}/{id}` and reads `ratings.simkl/imdb/mal`. The former webOS
`/ratings` shortcut omitted Authorization; a live unauthenticated request with
this V2 client ID on 2026-10-26 returned 401 `user_token_required`. Its browser
`redirect:manual` fallback could not expose Location either.

The packaged `com.tvkdevelopment.plezy.catalog` JS service now supplies only the
missing native HTTP capability, following LG's JS Service Usage packaging guide:
https://webostv.developer.lge.com/develop/guides/js-service-usage . It issues
read-only HTTPS requests to api.simkl.com for redirect/detail paths, never follows
redirects, and neither stores nor logs credentials. The UI supplies its connected
session and reuses SimklTracker's refresh owner. Failed lookups aren't cached;
known empty replies and real scores use Plezy's 12-hour cache. Each provider still
updates the metadata ratings pill independently.

Install the complete IPK (`npm run package`, which includes `service/`). Serving
`dist/` in a desktop browser cannot provide this native transport; browser tests
simulate PalmServiceBridge explicitly. This is a transport adaptation, not an
alternate catalog lookup or title-matching algorithm. LG TV installation, Luna
permissions and live authenticated scores still require hardware verification.

### Resume at decoder open

Native Plezy opens `Media(videoUrl, start: timing.mediaStart)` in
`lib/screens/video_player/parts/playback_open.dart`. Its Plex client deliberately
omits a transcoder URL offset (see `buildTranscodeStartPath`, issue #1859): the
URL describes the full title and the decoder selects the resume segment.

The LG equivalent is a `<source>` with an encoded `mediaOption` in its MIME type:
`option.transmission.playTime.start` in milliseconds, attached before `load()`.
See https://webostv.developer.lge.com/develop/guides/resuming-media-with-mediaoption
and https://webostv.developer.lge.com/develop/guides/mediaoption-parameter .
LG explicitly documents that setting `currentTime` after loading buffers twice.
Both direct MP4 and HLS use this native option on webOS. Metadata/ready events
must not issue another initial seek. Plex URLs have no resume offset and all
progress, chapters and seeks retain the original full-title timeline. Desktop
preview retains its HTML seek path because it has no LG media pipeline.
Release removes source children before unloading so a later open cannot reuse
an old URL or resume option. Tests verify source configuration, startup reporting,
no second seek, and source cleanup; actual buffering on LG requires TV validation.
