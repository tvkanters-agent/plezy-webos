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

### Missing cast portraits

Native `CastMemberStrip` and `ActorMediaScreen` pass
`Symbols.person_rounded` to `OptimizedMediaImage`, using a centered
40px symbol for absent, loading and failed images. The webOS port uses
a shared inline SVG because Chromium 53 does not ship Flutter's icon font.
Only a successfully loaded image covers the placeholder; an error removes
the image to avoid the browser's broken-image glyph. Square and circular
portrait clipping is retained.

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
| Settings hierarchy, grouped rows and subpages | `lib/screens/settings/settings_screen.dart`, `playback_settings_screen.dart`, `services_settings_screen.dart`, `about_screen.dart`, `lib/widgets/settings_section.dart`, `setting_tile.dart`, `settings_page.dart` |

### Settings screens on webOS

The webOS settings hub follows the original `SettingsScreen`: a top group of
navigation rows, a separate **Connections** group, and **About** at the bottom.
Rows use `SettingsGroup`'s 20px outer / 5px inner corners with 2px gaps,
leading symbols, title/subtitle, and a trailing chevron or switch. The native
`SettingsPage`/`SettingSelectionTile`/`SettingNumberTile` pattern is preserved:
subpages use a Back header, selection and text/numeric values are edited in
focusable dialogs, and Back restores the originating row and scroll position.

Only currently implemented webOS options appear: Video Playback (Player,
Subtitles and Auto-play & Skip), Manage Libraries, Services (Simkl and MDBList), Connections,
and About. The original General and Appearance pages, and native-only playback
preferences, are omitted rather than populated with invented settings. Server
connection details and the enhanced SRT playback switch are existing webOS-only
controls placed in the closest original group. First-run server connection and
standalone Simkl linking remain available. Flutter's Material rows are rendered
as grouped HTML/CSS and inline SVGs because webOS Chromium 53 cannot run Flutter
widgets or load the Material Symbols font. TV remote, focus, Back, form error and
persistence cases have browser tests; physical LG TV validation is outstanding.

### SRT subtitle styling

The `Subtitle Styling` subpage of Video Playback ports upstream
`SubtitleStylingScreen`'s `Text` and `Border` settings, with identical defaults,
input ranges and persisted meaning. `Font Size` (10–80, default 38), `Text
Color`, `Position` (0–150, default 100), `Use margins`, `Bold`, `Italic`,
`Border Size` (0–5, default 3), and `Border Color` work only with the existing
enhanced-playback local SRT/VTT renderer. The original ASS Override and
Background sections are intentionally absent per user request. Legacy Plex
burn-in remains untouched, and ASS/SSA retains its authored formatting.

MPV sizes subtitle font and border in units at 720p; webOS scales these with
the display height. Native MPV paints the border *behind* the glyphs.
In 1.19.0 the enhanced SRT/VTT renderer uses **PixiJS 4.8.9** (its CanvasRenderer,
which requires no WebGL overlay above LG's hardware decoder). Media Captions
still parses text; its HTML cue painting and the SVG outline/MutationObserver
have been removed for SRT/VTT. Pixi rasterizes each visible text run at 2x
resolution and composes it at the display's native resolution with a rounded
Canvas stroke beneath its filled glyph. Unlike blurred alpha, this retains
clean concave letter corners and limits rounded joins to the stroke exterior.
Only newly visible cues or changes to settings/size regenerate text textures;
the playback animation clock merely checks the active cue index. The library
and its MIT license are packaged locally and loaded only on first enhanced
SRT/VTT use. Compatibility playback never instantiates Pixi or custom captions.
Inline SRT bold/italic, explicit line breaks and word wrapping use per-run
Pixi Text objects. Advanced WebVTT markup, ruby, vertical cues and regional
layout remain outside the native-MPV parity guarantee and need TV validation.
The local overlay uses the
video rect when `Use margins` is off and the whole screen when enabled. For
LG hardware planes where `videoWidth`/`videoHeight` report zero, Plex media
metadata provides the fallback aspect ratio. Default-placement cues are
repositioned like Plezy's text cues; authored cue placement is retained.
D-pad-compatible HSV/hex color and numeric editors replace native Flutter
dialog widgets. Browser tests cover stored settings, keyboard focus, cue timing,
Pixi Text style/geometry and rendered canvas pixels. Physical LG caption
placement and exact MPV pixel parity remain unverified.

These are pointers, not claims of completed porting. The current HTML frontend still has parity gaps and must not be described as faithful merely because a similarly named feature exists.

### Season initial focus

On LG TV, opening a season starts remote focus on its Play button (as episode
details already do), even though the parent-series link precedes the actions in
the DOM. This is a user-requested focus preference; native
`MediaDetailScreen._scheduleTvDetailReveal` currently selects primary-action
focus for movies only. The series link stays reachable by directional input.

### Episode source-track menus

Native `EpisodeCard` opens `MediaContextMenu` on long press or secondary tap;
`_buildItemMenuActions` offers watched/unwatched according to the episode's
current and partial progress. The webOS season row provides a visible More
options disc because LG TV remotes have no reliable right-click/long-press
equivalent. Episode detail More options uses the same actions.

Native `TrackChapterControls` opens a single `TrackSheet` with source audio and
subtitle columns and selected-track ticks. The player now uses that combined
structure, selecting source IDs from `Part.Stream` / MediaBrowser `MediaStreams`.
The original sheet controls an existing MPV player. The requested pre-play
episode selector is a webOS-only adaptation: it reads complete episode metadata
if the season listing omitted streams, stores the choice for that episode in the
active account's memory, and applies it when playback starts. Plex stream
selection uses the port's existing part PUT + HLS restart; this cannot provide
MPV's seamless decoder-side switching or external subtitle search on webOS.
Tests cover IDs including zero, menu focus, watched actions and request params.
At the user's request, the webOS episode More options disc renders only
`more_horiz` SVG circles, with its full per-episode name kept in `aria-label`.
The pre-play track chooser stays open after a selection so audio and subtitles
can be adjusted together without repeatedly opening the episode menu.

The same existing pre-play TrackSheet adaptation is now offered from movie,
show and season detail More options menus, as well as episode menus. Movies
save source IDs for the selected media version only; no language preference
leaks to other movies. Shows/seasons lack their own media streams, so their menu
resolves the episode that the existing Play action would start (On Deck or the
first available episode) and records that episode's choice. The established
per-series language/role carry applies it to matching sibling episodes when
played, without sending an arbitrary episode's stream IDs to another part.
Changing a pre-play choice still makes no server request until playback starts.
Native Plezy has a read-only playback-track preview on show/season details;
this selectable menu is a user-requested webOS extension. Focus/Back and
version/part ID forwarding have browser regression coverage, not TV validation.

### Detail-page playback track status

Native `media_detail/playback_tracks_status.dart` places a non-focusable,
single-line preview at the right edge of the action row. It probes the source
of the episode Play would start on a show/season and projects its video labels,
selected audio with `volume_up_rounded` and subtitles (including `Off`) with
`subtitles_rounded`. `FittedMetadataLine` drops technical details and picture
labels before the subtitle choice when horizontal space is limited. The webOS
status uses the same source catalog and the existing session track carry,
updates after version/menu changes, and remains live after a detached detail
screen is restored with Back. It never takes focus or starts playback.
Chromium 53 renders equivalent inline SVGs and measured flex-line shedding in
place of Flutter's icon font and `LayoutBuilder`. webOS has no native Plezy
account-profile selection ladder; the preview follows the port's current
pre-play stream resolution (explicit carry, server selected, then first audio),
not an unimplemented profile preference. Browser geometry and behavior are
tested; TV rendering remains unverified.

Native `TrackSheet` closes on an MPV track tile tap. The user explicitly
requested the opposite for this port: the player TrackSheet remains visible
after a track selection, even when webOS must restart HLS to apply it. The
restart retains the sheet and restores focus to the chosen track, including
after a decoder fallback. Back and Close still dismiss the sheet.

### Cross-episode audio/subtitle preference carry

Native `VideoPlayerScreen._navigateToEpisode` carries the current audio track as
an item-agnostic intent and subtitles via `SubtitlePreference.demoteToIntent`,
unless `followServerTrackSelections` is enabled. `TrackSelectionService`
requires matching language and forced-class evidence, prefers role/title
over codec/channel tiebreakers, and rejects ambiguous candidates rather than
choosing by stream position. Off subtitles remain an explicit intent.

webOS currently launches episodes from separate season/detail routes rather
than performing MPV's in-place Next Episode navigation. To make the requested
cross-episode choice available through these routes, the last explicit audio
and subtitle selections are remembered per series **for the app session**.
Selections from either pre-play episode menus or the playing TrackSheet apply
to other episodes, including other seasons, when source track semantics match.
Source IDs are never reused across episodes. A missing or ambiguous target
falls through to Plex/Jellyfin's own item selection; missing lightweight
stream catalogs are fetched before opening an episode. Choosing a new track
supersedes earlier sibling episode choices for that kind only. Server switches
discard the session memory. This is a webOS navigation adaptation, not a
server-side bulk update, account-wide preference change, or a promise of
persistence across restarts. For HLS (including enhanced SRT/ASS video),
 the selected source audio ID must be present in the HLS start/decision URL
 as well as the part-selection PUT; custom captions continue to use the
 matched subtitle ID only in the separate subtitle asset, with HLS subtitles
 disabled. LG hardware playback remains to be checked.

### Stable transport discs and chapter metadata

At the user's request, the webOS transport row omits the dedicated previous/next
chapter discs found in Flutter's `DesktopVideoControls`. Chapter seeking remains
available through the Chapters sheet and the Programme Up/Down remote keys.
On webOS, Plex chapter metadata can arrive after playback has already started.
The Chapters menu disc stays in the row from the first frame (disabled until
chapters are available), rather than changing transport geometry; Audio &
Subtitles also remains mounted even when only the default tracks are present.
This is a deliberate webOS UI adjustment to prevent startup chrome flicker.

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

When Stop interrupts HLS startup, webOS unloads and discards the video element,
following Plezy's route-scoped player teardown in `_shutdownVideo` and `dispose`.
The successor ignores callbacks from the retired element. LG can publish the
resume position on `timeupdate` after `playing`, so the HLS first-frame gate
also checks the playback clock when it updates. Playwright simulates these
callback orders with no second seek.

### Browser decoder buffering vs native cache pause

Native Plezy's buffering overlay follows mpv's `paused-for-cache` state and
retains its initial-frame gate. `HTMLMediaElement.stalled` instead means the
network stopped delivering bytes; it does **not** mean the video has stopped
advancing, especially for a fully cached file near credits/EOF. On webOS,
`waiting` and `stalled` only raise the spinner when playback is active and the
decoder has less than `HAVE_FUTURE_DATA` (readyState 3); paused or ended media
must not raise it. Pause clears stale buffering except while a startup frame or
seek preview is still pending, and `seeked` can clear a paused seek without
waiting for a `playing` event. Browser-event unit tests exercise these guards;
the native decoder's exact event ordering remains an LG TV verification item.

### Playback return without blank navigation frames

Native Plezy retains the covered detail route during playback
(`lib/screens/media_detail_screen.dart` uses `RouteAware.didPopNext`;
see `test/screens/video_player/player_route_exit_test.dart`). The webOS
player similarly keeps the detail DOM beneath its overlay. On Stop/Back,
restore the focused launch action and refresh resume/watched controls from
server metadata **in place**. Re-rendering the page after hiding the player
temporarily empties the screen and loses remote focus.

### Watched/unwatched actions without blank detail frames

Native `WatchActions.setWatched` emits a watch-state event and
`MediaDetailScreen` updates its mounted metadata without displaying a loader.
The webOS detail action now patches the active item's watched/progress fields,
refreshes its existing action buttons and saves the updated detail cache after
server acknowledgement. It does not call the route renderer or reset artwork,
scroll or remote focus. In-flight detail revalidation from before the action is
retired to prevent stale responses from remounting the page during a mark.
The episode More options watched actions use the same mounted-control refresh.
Like native detail screens kept alive beneath a pushed route, webOS detail
snapshots on the Back stack receive acknowledgements for the same title and
account. A season's retained grid updates its episode rows and applies the
acknowledged state to pages arriving later. Browser tests assert DOM identity
and focus continuity. Actual LG playback and focus require hardware verification.

### Alphabet rail in large libraries

The library browse rail translates
`lib/screens/libraries/alpha_jump_bar.dart`,
`alpha_jump_helper.dart`,
`library_alpha_bar_strategy.dart`, and
`tabs/library_browse_tab.dart`. It is rendered on TV when there are at least
80 entries and six nonempty Plex first-character buckets, only under
`titleSort`. For Plex the actual per-letter counts come from
`/library/sections/{id}/firstCharacter` with `includeCollections=1`.
Cumulative offsets jump directly to nonloaded Plex items; the webOS grid
retains an index-aligned window with spacers rather than attempting to render
all intervening DOM cards. This is the Chrome 53 replacement for Flutter's
sparse `SliverGrid`. The displayed/current letter, pointer gestures, 150ms
D-pad stepping, remote Back/Left return, 24px tonal letter rail, 24px TV
overscan, and circular highlight follow the original widgets. At the user's
request, TV letters grow to 14px (from upstream's 10px maximum), with 22px
markers and a correspondingly wider lane. They still shrink dynamically when
the viewport is too short to display the complete alphabet.

Jellyfin and Emby use Plezy's separate `MediaBrowserAlphaBarStrategy`:
27 synthetic `#`–`Z` entries acting as server-side `NameStartsWith` filters
(`#` is `NameLessThan=A`), with the active prefix toggled off by reselecting
the letter. No per-letter Plex offset approximation is applied to those servers.
The browser-level letter rail and title DOM snapshot are preserved during
navigation to a media detail and back. TV-only actual remote and real Plex/Jellyfin
library geometry still require hardware verification; desktop Playwright tests
cover server requests, navigation, focus and fallbacks.

### Alphabet jump and focus clearance

`LibraryBrowseTab._gridTopPadding` reserves decoration clearance separately
from page chrome; `_navigateToGridNearScroll` selects the last column of the
jumped row. The HTML port retains its existing 10px grid decoration padding
at the viewport edge when jumping. Both index lookup and D-pad reveal use
that same inset (read from the grid), never the outer main padding. This
small browser geometry adaptation leaves the preceding row outside the pane
and prevents a second scroll when focus enters or crosses the target row.
Regression coverage exercises both CSS Grid and Chromium 53's flex fallback.

### Browser layout work during browsing

Flutter's `FocusableMediaCard` and `LibraryBrowseTab` retain focus zones and
layout geometry through the framework. Chromium 53 uses DOM geometry instead.
D-pad decisions reuse each element's bounds only within one synchronous key
handler; reveal still measures independently, and every new key measures afresh.
The first poster's sidebar exit measures its own bounds and the rail
destinations once to select the nearest visible rail button. This preserves
spatial scoring and avoids caches becoming stale after scroll/resize.

Alphabet-grid measurement reads the first row and the first card of row two,
matching upstream's shared column/row metrics. Later rows need no measurements.
The single-row height fallback and resize-triggered page realignment remain;
browser tests cover the measurement bound and jump placement in grid and flex.

The artwork queue batches viewport reads before assigning image sources, avoiding
read/write/read layout work in Chromium. It retains the two-request limit,
prefetch margins, document order, error handling and OptimizedMediaImage fade.
Tests verify read-before-write ordering, deferred artwork and concurrency.

Right from the sidebar during library loading parks focus on the content pane
until the initial page completes. This replaces up to 120 animation-frame polls
with the existing page-completion handoff, translating Flutter's retained
preattachment focus request in `LibraryBrowseTab._navigateToGrid`. A deliberate
focus move before completion cancels the handoff. Delayed-response tests cover
both entering the first card and leaving the pane while data is pending.

### Main-pane Left exit to the navigation rail

On webOS, Left from the leftmost content item transfers focus to the vertically nearest visible sidebar destination instead of the selected destination. CastMemberStrip retains internal Left/Right movement, but Left from its first member exits instead of saturating (a user-requested departure from Flutter). Right from the sidebar restores the previously focused content item. Browser tests cover this behavior.

### Locked-focus horizontal hub boundaries

Native `HubSection._handleKeyEvent` consumes Right even at its final card, so
another hub can only receive focus through vertical navigation. The webOS
`main .cards` rows use native button focus instead of one Flutter `FocusNode`;
Right therefore searches only the current carousel. Reaching the last card
leaves focus and the other carousels' scroll positions unchanged. Left from
the first card continues to exit to the sidebar as explicitly requested.
Multi-carousel browser tests cover the right boundary and normal movement.

### Unclipped Home hub gutters

Native `HubSection` builds its horizontal `ListView` with `clipBehavior: Clip.none`
and applies the TV shelf inset to the list's initial/final padding. The webOS
equivalent extends each top-level `.shelf .cards` scrollport through the main
pane's left/right 48px padding (32px at narrow widths), while restoring that
inset inside the scrollport and on the heading. Cards scrolling offscreen can
remain visible throughout the side gutters; at rest their first card remains
aligned with its heading. CSS overflow clipping still occurs at the actual
main-pane edges, because Chromium 53 cannot implement Flutter's unclipped
sliver viewports directly. Browser tests cover hit-testing in both gutters,
initial alignment and the responsive inset; LG hardware is unverified.

### Cached navigation and artwork under memory pressure

The source `OptimizedMediaImage`, `PlexImageCacheManager` and library prefetch
logic distinguish disk files from decoded image RAM. The webOS equivalent now
releases its decoded `Image` references independently of the compressed Blob
URL cache. Landing artwork receives preference but cannot monopolize either
RAM budget and immediately evict every newly scrolled image. Disk-only probes
run outside the two network-download slots, so slow downloads cannot block
already-saved images. Transient fetch failures use a short origin backoff rather
than disabling persistent downloads until restart.

IndexedDB replaces native Plezy's filesystem/database services. Saved library,
detail, child-list and actor pages are shown before background revalidation;
changed responses reconcile with the active route. Navigation prepares available
metadata and decoded artwork while the previous route is still mounted, avoiding
an empty intermediate paint. Missing artwork probes are remembered for the
session (and cleared on save), avoiding a second disk lookup during page render.
Home metadata remains session-only and is refreshed after playback, watched-state
changes, explicit refresh and account changes, including Back navigation. It no
longer expires simply because 45 seconds elapsed. These cache-first/session
policies follow the user's requested webOS behavior; they do not claim identical
upstream persistence policy.

Regression tests cover bitmap pressure without extra downloads, origin recovery,
restart detail reuse and background changes, cached artwork behind blocked
network slots, session Home behavior and frame-by-frame cached navigation.
Browser simulations and Chromium 53 bundle validation do not establish physical
LG TV disk latency, decoder behavior or server CORS support.

### Skip intro, outro and credits markers

The webOS marker pipeline translates `MediaMarker` and
`PlaybackExtras.withChapterFallback` from `lib/media/media_source_info.dart`,
including the upstream-shaped intro/credits defaults (with the user-requested
logo extension below), 180-second synthetic intro cap,
75%-of-chapter-timeline minimum for synthetic credits, Plex-marker precedence,
and the chapter-fallback override. Jellyfin first attempts
`/MediaSegments/{itemId}` as in `lib/services/jellyfin_client/parts/playback.dart`;
Emby and older Jellyfin servers use chapter names instead. Segment failure
does not stop video playback.

**User-requested pattern extension:** The webOS default intro regex includes
`logos?` alongside upstream's `intro`/`introduction`/`opening`/`op` matches.
Plex/Jellyfin chapters named "Logo", "Logos", or "Studio Logos" can therefore
become intro markers when a native intro marker is absent. Word boundaries,
native marker precedence, the three-minute synthetic intro cap, and explicitly
configured custom patterns are unchanged. The original Flutter default is
left untouched; this is a webOS-specific requested matching rule.
Also by user request, immediately adjacent chapter-derived intro markers
(e.g. Logo followed by Opening) are joined into one range so one skip jumps
past both chapters. The join permits up to 250ms of metadata rounding but not
an intervening content chapter, and never exceeds the existing 180-second
combined intro safety threshold. Native Plex intro ranges remain authoritative.

`Player` translates `video_controls/parts/markers.dart` and
`widgets/skip_marker_button.dart`: off/button/auto modes per marker kind,
5-second default countdown, cancellation on user remote input, 7-second
dismissal, prompt focus, and a floating white progress button independent of
the playback chrome. The browser video `timeupdate` / `loadeddata` events
stand in for the Flutter MPV position and first-frame listeners. Near-EOF
credits trigger title completion rather than seeking to EOF; the original
"Next episode" prompt cannot be invoked because webOS has no equivalent
episode queue yet. Remote/decoder timing and native media-segment transport
on physical LG TVs remain hardware-verification tasks.

Plex playback additionally fetches `/library/metadata/{ratingKey}` with
`includeChapters=1&includeMarkers=1` independently at startup, matching
`PlexClient.getPlaybackExtras`. Cached Home/detail metadata may not include
`Marker` or `Chapter`, and must not be the sole source for the prompt. The
playing session accepts the returned extras without restarting video; an
unavailable server leaves its cached extras intact. Chapter names prefer
Plex's `Chapter.tag` as in `plexChaptersFromCacheJson`. LG's `playing` event
also establishes decoder playback when webOS reports a stale `readyState`;
this is required for the first-frame gate that controls skip-prompt display.

Unit tests cover parser and fallback precedence and browser tests cover
appearance, manual/automatic skip, preferences and remote cancellation.

### Chapter navigation and skip-prompt focus

`MediaChapter.indexAtPosition` and `seekTargetIndex` provide the current row
and transport jump targets. The player now reproduces `ChapterSheet`'s focused
current row, its two-line title/time labels and supplied Plex chapter thumbnails,
as well as `BufferRangePainter`'s 4px timeline chapter divisions. Ensure the
timestamp's minimum-width CSS only targets direct `.timeline-row` children:
applying it to nested `.chapter-gap` spans makes each separator 52px wide
despite an explicit 4px width. LG's existing
transport strip adds previous/next chapter discs when metadata is present;
media rewind/forward keys choose chapters where available, retaining timed
seeks without chapters. The native three-second previous-chapter restart
threshold and start-of-title fallback are preserved.

Programme Up/Down (legacy PageUp/PageDown keycodes 33/34) now use this same
next/previous chapter traversal and the existing timed seek fallback when no
chapters exist. These buttons are **not guaranteed to work on LG hardware**:
the older NetCast remote API mapped Programme +/- to Page Up/Down, but LG's
current webOS TV Magic Remote documentation reserves Channel +/- as system
buttons and says web apps cannot receive them. The handler only works if a
specific TV/remote sends those legacy events (or a keyboard sends PageUp/Down).
No privileged key interception is attempted. Physical LG C8 verification is
still required. References:
https://webostv.developer.lge.com/develop/guides/magic-remote
https://forum.webostv.developer.lge.com/t/cannot-press-channel-up-down-to-trigger-an-event/18008

When a skip marker first becomes visible during active TV playback, focus goes
to its floating action so one LG OK press skips it. If the first decoded frame
arrives while playback is still paused, focus waits for `playing`; an open
track/chapter sheet keeps its existing focus. webOS can dispatch remote OK
without synthesizing a DOM click on a programmatically focused button, so the
player handles that key explicitly. Browser tests simulate TV detection and
keyboard focus; physical LG remote and decoder timing remain unverified.

Native `SkipMarkerButton` uses `FocusableWrapper(useBackgroundFocus: true)`
with a 1.02x focus scale and 8px corner radius. Its HTML counterpart must not
use an external CSS outline: older LG Chromium draws an ugly square even on a
rounded button. The prompt fills brighter and scales slightly on focus.
After activating a skip, LG can continue reporting a pre-seek position during
buffering. The player keeps that exact marker suppressed until the viewer
explicitly seeks again or playback resets, rather than reinstating its prompt
while the native decoder catches up. This does not suppress other markers.

Native `TimelineSlider` gets Plex scrub frames from
`BifThumbnailService` (`/library/parts/{id}/indexes/sd`), using its indexed
JPEGs in a 160px image tooltip above the timeline. The webOS range slider now
uses the same BIF timestamp lookup, capped at the upstream 50 MiB TV budget,
with an ordinary time tooltip if the server has no index. Frame URLs are
revoked on scrub exit and source changes. Its use of a separate thumbnail
source avoids depending on LG's video decoder producing a paused seek frame.
Like Plezy's `DesktopVideoControls._timelineSeek`, repeated Left/Right
changes affect only preview state until a single confirmed seek; the user
specifically requested OK to commit on webOS (rather than Flutter's debounce/
key-release commit). On webOS an unconfirmed preview is canceled by Back or
focus leaving the timeline, restoring the preceding playing/paused state.
No `video.currentTime` assignment or buffering spinner is triggered by preview
movement: LG's native video pipeline would otherwise buffer on each step.
Jellyfin Trickplay remains outside this Plex-focused port; full TV hardware
verification is still needed.

Unlike Flutter's persistent focus nodes, HTML video decoding on webOS may
blur a transport control to the document body. The player tracks the last
selected transport control and restores it on `playing` without taking focus
from track/chapter sheets. It keeps chrome visible while the user is focused
in that strip, and Left/Right can seek only from the slider or video surface.
Moving focus off the remote timeline discards its unconfirmed preview. Delayed
decoder pause/playing events and synthetic focus/mouse notifications must not
reopen controls explicitly hidden by Back; the second Back exits the player.
The floating
skip prompt is positioned above the *measured* transport chrome instead of
using a fixed bottom offset that overlaps the seekbar on different TVs. Moving
a mouse over the floating prompt must not reveal the controls underneath it:
that changes the prompt's anchor and can make a single click miss entirely.
The measured offset is cached for the entire visible-chrome state: its
render routine must not clear the offset on subsequent `timeupdate` events.
Only an actual chrome hide, prompt dismissal, or viewport resize invalidates
that measurement. Browser tests dispatch repeated playback events to catch
alternation between the correct offset and the bottom of the screen.

`TimelineSlider` focuses its range via `_FocusKnobThumbShape` and
`paintPlayerFocusKnob`: a solid white disc of 9px radius with a shadow, not a
border around the slider. The webOS input's focused WebKit thumb follows that
shape, with a thin white handle otherwise. The user requested BIF tooltips
roughly twice the 160px upstream size; they are now 320px wide on TV, capped
to the track width for unusually narrow layouts.

### Viewport-bounded artwork and incremental catalog updates

Native LibraryBrowseTab uses lazily built sliver rows. Since Chromium 53 does
not support reliable native image lazy loading, WebOS predecodes only the first
viewport and two following rows, or visible Home shelves and nearby shelf rows.
On-page scroll loads remaining artwork through the existing bounded queue.
The window is estimated from TV card geometry before the cards are mounted;
the real visible-image queue measures DOM bounds after mount on scroll or
content changes, not after each completed image.

Like LibraryBrowseTab.performLiveLibraryRefresh, the webOS normal and sparse
alphabetical grids reconcile changes by stable ID and item metadata, retaining
DOM, decoded images and focus for unchanged cards. A changed page length still
invalidates the offsets of all subsequent loaded pages.

Plex title loading proceeds independently of first-character lookup.
The sparse grid mounts without an alphabet rail; when the index becomes
available and meets Plezy's threshold, the rail is attached without rebuilding
the grid. Overlapping persistent-catalog loads coalesce per account/key;
forced refresh supersedes stale requests, and generation checks preserve
account isolation and newer responses.

The image cache remembers disk misses and coalesces concurrent probes.
Merged Plex collections reuse an account-scoped disk-backed collection index
that serves cached data before background revalidation. Partial server failures
retain the last complete discovery index.

Browser tests and Chromium 53 compilation do not substitute for real LG TV
performance and disk-quota verification.

### Native webOS launch splash

LG displays `splashBackground` before starting the web app, so an HTML loading screen cannot replace the grey pre-launch background. The app declares a 1920×1080 PNG generated during the build from Plezy's unchanged `assets/plezy.svg` with the actual dark `webos/public/app.css` background. The already-required Playwright Chromium renders the vector; no browser, renderer or startup delay is added to the TV application. LG's `splashColor` setting applies only to StanbyME models, so the dark color is embedded in the PNG for normal TVs.

### Root navigation history

As in Flutter `MainScreen._selectTab`/`_selectLibrary`, choosing Home,
libraries, Search or Settings in the side rail selects a persistent tab
rather than pushing a new Back entry. The Back key on one of these tabs
returns directly Home; a second Back at Home opens the existing webOS exit
dialog. Detail, person and authentication routes remain pushed and restore
their covered page, scroll and focus on Back. Up to eight inactive root tabs
retain detached DOM for instant redisplay, with explicit cleanup of suspended
alphabet rails on eviction/account changes. Re-entered library tabs revalidate
first-page server data without blocking the first frame; changed responses
repaint while preserving scroll and focus. Browser tests cover repeated tab
switches, detail returns and switching tabs while a detail is open.

### Scroll-direction artwork buffering

The native `LibraryBrowseTab._prefetchImages` prefetches card images beyond
the visible range. The webOS `loadVisiblePosters` queue now also hydrates
three off-screen card rows above and below the pane during library scrolling.
Since Chromium 53 does not support reliable native lazy loading, it measures
the current card height and grid row gap (or flex row margin), prioritizes
visible images, then favors the scroll direction while keeping six network
downloads in flight. Already persisted artwork is probed independently of
those slots. Other images, such as Home shelves, keep their previous bounded
window. This mirrors the original intent, with an additional backward buffer
for remote navigation, without inflating the entire library.

### Fast library scroll range loading

Following LibraryBrowseTab._computeVisibleRange and PaginatedItemLoader.ensureRangeLoaded, the sparse HTML grid requests the current viewport directly when scrolling completely beyond its mounted range. It no longer walks every intervening page through empty spacers. Negative local rows map correctly into the leading spacer for reverse scrolling. One metadata request remains in flight; its completion rechecks the latest viewport without snapping scroll to the old target. Adjacent prefetch covers at least three rows or one viewport.

Scrolling cards mount immediately after metadata arrives, letting the bounded artwork queue hydrate placeholders independently, as native sliver cards do. Explicit alphabet jumps and initial navigation keep their cached-artwork preparation. Browser tests cover both grid and Chromium 53 flex geometry, blocked prewarming and delayed-request direction changes; hardware performance remains unverified.

Plex Recently added and Release date request the sorted section without container
offsets. Each response supplies the entire ordering for the scrollable grid and
replaces one cached snapshot. This webOS adaptation avoids mixing offsets from
different live orderings. The DOM still mounts the viewport and two nearby rows
on either side, including on the Chromium 53 flex layout. A partial response
offers Retry and a Browse by title action if the server enforces a cap.

### Seek play intent on the HTML decoder

Native Plezy's seek coordination informs the webOS timeline behavior. HTMLMediaElement.paused is an observation of the LG pipeline, not a reliable record of user intent during buffering. Per the webOS remote behavior, confirming any timeline or chapter seek requests playback even when it began paused; explicit Pause during preview or buffering vetoes the automatic resume. Canceling an unconfirmed D-pad preview never seeks and retains the preceding paused state. Play is requested at confirmation even if the pipeline reports paused=false/seeking=true, and retried without expiring during slow buffering. A seeked event permits keyframe landing; actual advancing time ends recovery. Explicit Pause, source replacement, errors and backgrounding cancel recovery. The bounded pause/play wakeup is reserved for a landed, frozen decoder. Event-order simulations do not establish physical TV behavior.

### Subtitle clock and controls clearance

Media Captions receives the current media clock on animation frames only while SRT playback is active, plus immediate pause/seek updates; no subtitle parsing occurs per frame. Negative shifted times are retained so a positive delay cannot display a zero-start cue early. Async SRT/ASS construction reads the latest applied delay, never its stale download-time argument. The caption lift uses the actual transport height and is refreshed on resize. ASS canvas positioning stays with libass. These are minimal HTML equivalents of MPV's timed cues and Flutter's measured chrome clearance.

### Regression follow-up: retained rows, watch state and track restarts

Episode menu wrappers retain a separate catalog identity while their play and overflow controls retain stable focus IDs. Catalog reconciliation can therefore preserve unchanged rows and restore the specific control. As with WatchStateNotifier, a server-acknowledged aggregate watched action updates mounted children, their source metadata and saved child pages without remounting artwork; older revalidation cannot undo it. Later loaded children inherit the aggregate action while the route stays mounted.

Source-track PUT follows PlexClient.selectStreams and treats HTTP success as success regardless of an XML/empty body. Rapid changes merge their options and position before awaiting old-session cleanup, and paused track changes pause again after the first resumed decoder frame (LG needs Play to decode that frame). Subtitle offset storage is scoped by the existing account/server fingerprint plus item ID; ambiguous old unscoped offsets are not migrated. Only the latest pending episode Play action may launch after metadata arrives.

### Enhanced ASS removal (1.22.10)

Enhanced ASS/SSA playback was removed after incorrect rendering and unreliable
startup/seek synchronization on LG webOS. ASS/SSA always uses Plex's original
HLS burn-in, regardless of previously persisted `assPlayback` or
`enhancedPlayback` values. The ASS switch, SubtitlesOctopus/libass worker,
font/track caches, incremental event loader and build assets are removed.

Enhanced SRT/VTT remains opt-in and unchanged in intent: compatible direct
playback with a PixiJS overlay, or a clean HLS stream with embedded SRT
extraction. SRT-to-SRT and SRT-to-Off change only the overlay, without
reopening the decoder. Changing between SRT and ASS must reopen playback,
because Plex must add or remove the burned-in subtitle pixels. The current
media position, selected tracks and playing/paused state are preserved.

### Guarded native Direct Play

The user's playback-compatibility controls are the first two Player settings.
As of 1.20.0, SRT and ASS/SSA each have a separate opt-in switch. Both default
**Off** on fresh installations; users who previously enabled the single
Enhanced playback switch retain both local renderers enabled until they change
either setting independently. An off setting for the **selected** subtitle
format explicitly selects the historical
v1.10.2 Plex request path: conservative MP4 direct playback, H.264/AAC HLS
otherwise, Chrome's original profile and `subtitles=burn`, with no separate
subtitle fetch, transcode decision, or Matroska reader. The original Plex
server-selected subtitle is used unless the viewer explicitly selects a
track; the original part selection PUT is preserved. Off also greys out
subtitle sync with an explanatory Settings toast, since the TV cannot change
timing on Plex-rendered video pixels. The selected format's on setting opts in
to the later Direct Play and its local subtitle renderer with the existing
silent burn-in fallback; unselected and unsupported formats use the original
pipeline. Route selection precedes the video request, subtitle extraction and
renderer initialization. When video is already on the local route, moving
between enabled SRT and ASS tracks replaces the overlay without reloading the
video. Moving between local subtitles and Plex burn-in reopens the video,
since its pixels must change. Subtitle Off also clears the overlay without
reopening. This is a
user-requested reversible webOS compatibility gate, not a native Plezy
setting. Browser tests cover mode separation and requests; actual subtitle
pixels and video decoding still require LG hardware verification.

The first compatibility release restored the original Plex request but still
showed black video on a resumed MKV+ASS case. Version 1.15.1 assumed LG's
nonzero HLS `mediaOption` start was responsible, and replaced it with a seek
after `loadeddata`, introducing a second buffer. That assumption was not
verified: the user confirmed that before the recent subtitle/playback changes,
the same LG TV had always resumed correctly after a *single* buffer. As of
1.15.3 the two-phase workaround is removed. Both Off and On pass the exact
resume timestamp through the native `mediaOption` **before** video.load/play,
as v1.10.2 already did, following Plezy's `Media(start:)` behavior. A later
`currentTime` assignment is reserved for desktop browsers without the LG
pipeline. The Off Plex startup completion check also restores the older
first-frame semantics; it does not require newer `videoWidth`/clock-progress
heuristics that might reject real LG HLS playback. Regression tests cover
Off/On, HLS/direct file, the exact native start value and zero late seeks.
Decoder behavior still needs validation on the user's LG TV.

The original single-switch enforcement was introduced in 1.15.2. Since 1.20.0,
Plex's playback API treats missing, malformed and false `srtPlayback` or
`assPlayback` values as legacy **for the corresponding selected format**.
The player snapshots both settings for each open/reopen (including track changes
and decoder retries) and only constructs an overlay when that choice yields
an enhanced session. Off never constructs the custom subtitle overlay,
reads/applies subtitle offsets, starts Matroska extraction, starts a subtitle
download or triggers a renderer-failure restart. The ASS/libass runtime is
no longer loaded by the application shell; only an explicit enhanced ASS
track loads its script and worker. Leaving On disposes old overlay listeners.
This preserves the historical *MP4* direct-file decision while excluding all
newly expanded native formats and custom subtitle processing. Unit and browser
tests assert that MKV SRT/ASS in Off makes one original HLS/burn-in request,
no decision/extraction call and no ASS runtime load.

The reviewed native expansion is documented in [DIRECT_PLAY_REVIEW.md](DIRECT_PLAY_REVIEW.md). Unlike desktop mpv, LG HTML5 cannot select arbitrary embedded tracks; multi-audio files stay on HLS. Native-only AVC/HEVC formats require stream evidence within the C8/webOS 4.0 limits and correct source MIME. Independent SRT/ASS does not force a video transcode. Startup recovery is scoped to the session and remains armed past metadata until video clock progress, so native failures cannot hide indefinitely or suppress replacement HLS errors. Browser event tests are not hardware decode validation.

### Subtitle sync on Chromium 53 and real Plex sidecar keys

MPV applies sub-delay to decoded subtitle tracks. The HTML equivalent only
works while SRT/ASS are rendered locally; Plex burn-in contains fixed pixels.
Media Captions 0.0.18 uses Object.values in VTTParser.done (also used by SRT)
and Object.entries to render marked-up cues. Both APIs appeared in Chromium
54, while the target LG engine is Chromium 53. Conditional, nonenumerable
shims now provide those two standard operations before the renderer runs.
Without them, SRT parsing threw and the player silently reopened with burn-in,
so changing the sync slider could not affect the visible subtitles.

PlexClient._buildSidecarSubtitleUrl is authoritative for sidecar requests:
append the codec extension to Plex's bare Stream.key and request encoding=utf-8.
The port now does so, retaining already-suffixed keys, SSA format, query
parameters and account authentication. In 1.12.1 embedded/image subtitles
still followed upstream's HLS burn-in path.

Browser regressions remove Object.values, Object.entries and ResizeObserver
before application startup. They adjust the real UI while checking marked-up
SRT visibility at a fixed paused clock, and actual libass canvas pixels in both
WASM and legacy worker modes, including positive/negative delay and Reset.
This simulates the relevant missing APIs; physical LG decoding is unverified.

The libass-wasm 4.1.0 npm package's file list omits default.woff2 even though
the worker requires it. The port now vendors the unmodified fallback font
from the matching upstream tag (Git blob a562391696ad477e5a8ad28ef8b4d53c90bb0d42)
and its SIL OFL license in public/libass. It is copied with the application
and build-checked, so ASS never depends on downloading a font from a CDN.

### Plex embedded text and subtitle sync

Original Plezy's MPV player reads embedded subtitles locally on Direct Play.
LG webOS 4.4's HTML player cannot reliably expose and select them. The port
uses Plex Web's standalone HTTP subtitle route for embedded SRT and ASS/SSA,
`/subtitles/:/transcode/universal/start`. Plex rejected HLS on this route
with an invalid protocol error. The request selects the media version, part
and subtitle track with its own session, using the Web profile for ASS
output and maintaining full-title timestamps. Compatible video can Direct
Play, and HLS tells Plex to omit subtitles from the video.

Both transcode requests follow Plex's playback decision flow. Request the
decision with the exact source, profile and session params before opening
the video playlist or standalone subtitle. Plex can resolve the media and
still deny the start when a decision did not authorize that session.

Video transcodes follow Plezy's Generic profile with the MPEG-TS HLS target
used by its compatibility path. The TV target specifies H.264 and AAC.
Chrome already inherits an HLS target from the Plex Web profile, so adding
another one to Chrome produced a duplicate-target error in Plex Media Server.

Media Captions renders text from embedded SRT, including a Plex ASS wrapper
when supplied. SubtitlesOctopus receives an ASS/SSA payload intact so the
viewer's delay also applies to the title's styled signs and dialogue. If
Plex supplies a plain text conversion instead, the client renders that text.
If extraction, subtitle parsing or rendering fails (including a silent ASS
worker startup failure), retry once with Plex burn-in without an on-screen
warning. A burn-in encodes the selected subtitle into the video pixels, so
the subtitle sync row appears grey, stays remote-focusable, and displays the
requested toast when selected. A new track selection can retry local captions.

Browser tests use the real renderers with Plex-shaped HTTP responses, cover
subtitle arrival after video starts, and check what is drawn before and after
an adjustment. The TV's decoder and live PMS extraction are separate from
those tests.

### Embedded MKV subtitles from the original part

Plex's separate subtitle endpoints failed on the target setup in 1.13.1.
For MKV parts, the TV now reads the selected text track from the original
media, matching how Plezy's MPV player demuxes embedded subtitles. It uses
the Matroska SeekHead and subtitle Cues to request the track header, index,
and referenced blocks from the existing authenticated Plex part URL.
Plex stream index and Matroska codec must agree when both are available.
The reader requires partial HTTP responses, bounds total bytes and concurrency,
and aborts on track changes or player close. It retains full-title timestamps
and ASS script styles. ASS uses the bundled fallback font.

Plex extraction remains the fallback when byte ranges, the selected subtitle
index, or the container encoding cannot be used. The committed test
fixture was muxed with FFmpeg from synthetic black video, a sine wave, and
known SRT and styled ASS cues. Tests compare decoded cue times and track IDs,
then render the actual MKV subtitle bytes in the browser while the Plex
subtitle endpoint returns an error. Physical TV networking remains a
separate validation step.

The reader also handles Matroska zlib and header-removal compression and
walks cluster headers when subtitle Cues omit `CueRelativePosition`. It
rebuilds the ASS/SSA event format when CodecPrivate only includes the script
and styles. It reads and renders indexed clusters nearest the resume position
first, then adds the rest to the same overlay. The MKV range deadline measures
inactivity and the Plex subtitle endpoint has its own deadline. This lets
longer subtitle tracks load while playback and the timing control stay active.

For embedded SRT, the first preview now publishes after **one** nearest cue
cluster, rather than waiting for 12. Remaining clusters still fill in batches
without dropping any cues, and native webOS range reads remain serialized to
protect video decoding. Styled ASS retains its established initial batching
to avoid repeated heavy renderer initialization. This improves time-to-first
SRT cue after the video starts; MKV index discovery and the decoder-first gate
are unchanged. A delayed distant-cluster test covers early preview and final
full-track fidelity; actual latency on LG hardware remains to be measured.

As of 1.21.0, styled ASS also previews from the nearest cluster. It now
creates the libass track only once: the 4.1.0 event API is batched through a
small worker-side adapter so subsequent MKV events are appended without
reparsing the cumulative script. New events retain authored styles, override
tags, layers and full-title cue timing; the worker's style query waits for
actual initialization rather than the wrapper's five-second timeout. The
font attachment reader overlaps metadata/cluster I/O, avoids individual
requests for adjacent short EBML headers, and uses an IndexedDB font cache.
Cache matches are scoped to the Plex series using filename, length and the
first bytes; when an attachment has an EBML CRC, identical fonts can be reused
across titles. Changed/missing fonts are fetched again. Font storage is
opportunistic and cannot prevent playback if unavailable or out of quota.
As of 1.22.0, an initialized worker and its font registrations are suspended
and retained across enabled ASS sessions while no ASS subtitle is visible.
The worker's video listeners and resize observer are detached when suspended,
so switching to SRT or closing playback does not run idle rendering. A
different font set or disabling enhanced playback disposes the old worker.
Different ASS tracks with the same font bytes reuse the worker and replace
only the track, avoiding recompilation of the large legacy JS worker. Each
completed MKV ASS track is also cached separately from its font blobs using
the Plex server/part identity, size and selected track; repeat plays can skip
subtitle index and cluster range reads across app restarts.
ASS video-state updates additionally transmit their send timestamp, paused
state, and rate; a small bundled-worker adaptation projects queued updates
to receipt time while suppressing this projection during pauses/buffering.
The overlay additionally samples the real video clock every 250ms while ASS
is active, including paused position changes, and forces a seek redraw. A
stale `waiting` event cannot leave libass paused after decoded time advances.
No other playback mode instantiates the custom ASS runtime.

The diagnostic console logging added in v1.17.5 was removed in v1.17.7 at the
user's request after the legacy webOS inspector proved unusable on their PC.
The extraction and playback behavior remains the same as before the logging.

Since v1.19.1, **Settings → About → Diagnostics → Enable diagnostics** is a
general, persistent opt-in switch (default off). It replaces the SRT-specific
switch briefly exposed under Video Playback in v1.18.0; an enabled preference
from that version is migrated. Its first consumer is an on-TV text panel while
playing embedded SRT from an MKV through Enhanced playback. The panel reports
video startup, MKV index acquisition, first caption render, full extraction
and number/elapsed time of Plex byte-range requests. It can be photographed
with a phone; no developer inspector is needed. Future diagnostic features
should use the same `diagnosticsEnabled` switch. All diagnostic clock reads,
callbacks, aggregation and DOM creation are guarded behind the switch. Off
leaves normal playback without diagnostic work or visuals.

In v1.19.2, a retry with `skipMatroskaSubtitles` loads the independent Plex
subtitle sidecar as soon as the source starts, as external subtitles already
do. The previous raw `partUrl` check incorrectly waited for the decoder's
first-frame gate even after range reads were disabled. The optional diagnostics
panel also identifies whether the SRT came from MKV ranges, a decoder retry,
or an MKV read failure, including its error. This avoids ambiguous zero-range
readouts without introducing any measurements in normal (diagnostics-off) mode.

In v1.19.3, a valid `206 Content-Range` is authoritative even when a Plex
proxy incorrectly advertises the complete media size as `Content-Length`.
The webOS XHR reader still rejects and aborts actual oversized transfers,
checks the returned byte count exactly, and never buffers a whole-file `200`.
The optional failure readout distinguishes bad header length from actual
oversized body transfer so TV-only reports can identify the remaining issue.

In v1.19.4, the playing event starts a short (200 ms) decoder-settle timer
before the first MKV subtitle read. LG's hardware plane can be visibly playing
while its HTML video dimensions remain zero or its media clock still lags;
the old reader was waiting for both to confirm startup. Subsequent startup
recovery and the resume-seek gate remain unchanged. Playback generation and
session checks avoid duplicate or stale subtitle downloads, and diagnostics
optionally separate `playing` from `video ready` timing.

The webOS range reader now waits for playback to advance or for a requested
paused frame, including when resuming. It sends one abortable XHR at a time
and cancels a full-file response at the header boundary. If the decoder
fails during extraction, retry the same video route once using only the
separate Plex subtitle endpoint. When both subtitle sources fail, restart HLS
once with the selected track burned in, as the HTML decoder cannot expose the
native MPV subtitle track. The retry retains the playback position and explicit
track choice. This LG-only fallback is silent on screen; it does not
claim to recover a failed Plex video burn. Source changes abort the old range
request. The browser tests exercise ordering and failure handling; they do not
emulate the TV's network or decoder.

For an MKV SRT/ASS fallback, Plex burns the subtitle selected on the media
**part**, not the stream named in the HLS request (Plezy's
`PlexClient.selectSubtitleStreamForBurn`). The local-video attempt may have
disabled subtitles for its own HLS stream, and stale detail metadata is not
proof of the current server selection. Before the burn decision, select the
requested subtitle by `PUT /library/parts/{partId}?subtitleStreamID=…&allParts=1`,
even when it was Plex's default rather than an explicit user choice. If that
PUT fails, abort the burn attempt: success on the HLS URL alone cannot prove
any subtitle pixels were encoded. Browser and unit tests verify this request
ordering for both embedded formats; live PMS output remains TV verification.

### Enhanced subtitles with unavailable video dimensions

MPV owns subtitle composition in Plezy. The webOS overlay waits for video
startup before reading MKV ranges. Decoded-frame counters can establish video
output while the hardware plane still reports zero intrinsic dimensions.
Libass then sizes its canvas using the selected Plex media aspect ratio and
the video element's layout box until intrinsic dimensions become available.

### Packaged ASS worker resources

The installed app opens a local HTML file. Chromium can refuse a separate local
worker script or font request from that origin. The build packages each libass
worker in bounded classic-script chunks loaded on demand. The selected worker runs from a Blob
URL, initializes the default font directly in its filesystem and, on newer
engines, receives the bundled WASM bytes. Browser tests open the built local HTML
and check drawn ASS pixels and timing for both worker variants.

SubtitlesOctopus reports ready on its first worker message. On webOS that
can leave the viewer without dialogue even though playback and the sync
control are active. Enhanced playback starts libass with the current playback
state, rate, numeric offset and supported font attachments from the MKV.
Timed dialogue recovery starts on worker failure or after eight seconds without
a painted frame. The styled canvas
is anchored to the player viewport. If the worker fails, dialogue continues
locally with the selected track and offset. The HTML fallback omits typesetting.

### ASS video clock ownership and startup (1.22.4)

Native Plezy delegates subtitle track clocks and seek state to MPV. On webOS
the independently rendered libass canvas must follow the hardware HTML
decoder. The vendor SubtitlesOctopus wrapper attached its own timeupdate,
playing, pause, seek and waiting callbacks in addition to the webOS overlay.
Those competing callbacks did not transmit the corrected sender timestamp,
stalled-state guard or playback rate. The bundled wrapper now disables only
its clock callbacks when Plezy's local ASS overlay owns the clock; viewport
resize and metadata observation continue. When resuming a parked worker, the
callback detachment is re-applied. The worker processes rate and pause before
video time to avoid rendering a transient frame from the previous seek state.
A new worker only installs incremental dialogue events after its initial
style/track ready response, rather than sending a premature second style
query. The native first-frame and resume seek gates remain authoritative;
once either loaded video or first-frame playback is confirmed, embedded ASS
extraction does not wait another 200ms, and paused title opens may read the
subtitle track. Physical C8 tests are needed to verify these changes.

To reduce worker startup time, its bounded local script pieces are loaded in
parallel groups with stable part indices before being concatenated into a Blob
worker. This does not change the bundled libass runtime or fonts. For worker
first-frame detection, the renderer trusts libass's nonempty blended image
payload rather than downsampling the drawn canvas to 160 × 90 pixels, which
could miss a very small sign. Both changes are exclusive to enhanced ASS.

### Versioned ASS worker assets (1.22.5)

On LG webOS, installing a new IPK under the same app ID does not guarantee
that every previously loaded file:// classic-script resource is evicted.
Version 1.22.4 changed the generated libass worker pieces from sequential
pushes to indexed assignments without changing the URLs. Combining cached
pieces from two releases can produce an invalid Blob worker, preventing
embedded ASS fonts from ever loading. The app now loads all libass assets from
a release-specific `libass/v<version>/` directory, not the old unversioned
paths. Worker pieces are loaded sequentially and checked for gaps before
assembling the Blob. This is narrowly scoped to ASS worker script assets;
no IndexedDB databases or keys are modified, and the 1.22.4 clock, first-
frame, and earlier extraction fixes are retained.

### Cached ASS startup and seek priorities (v1.22.6)

The embedded ASS path can warm verified persistent ASS scripts/fonts before the
video finishes its initial native resume seek. The optional decoder-network
gate applies only after a cache miss, preserving the original ordering of MKV
range requests after the video first decodes a frame. This gate is abortable;
closing/switching tracks cannot resurrect a stale subtitle download.

Incremental ASS event import now prioritizes the current timestamp and the
following eight seconds (preserving original order inside that window).
Subtitle clock updates are sent before forced redraws on pause/seek, so the
worker cannot render the old time after installing newly available sign events.

This does not modify cached font databases or the versioned ASS worker loader.

### Account-scoped artwork cache and credential removal (1.22.14)

The Chromium 53 IndexedDB artwork cache must never persist authenticated image
URLs as object-store keys: Plex supplies `X-Plex-Token`, while Jellyfin/Emby
supply `api_key`. Artwork keys now combine the existing token-free catalog
account scope with a deterministic URL-and-revision fingerprint. The request
still fetches the original authenticated URL; cache lookup retains independent
revisions, dimensions and accounts without storing tokens in disk key strings.

Removing a server also invalidates its scoped artwork in RAM and IndexedDB
without touching other server scopes. Scope generations reject late fetches,
disk reads, and queued writes after removal, even if the same server is linked
again. Previously persisted URL keys cannot be securely attributed to the new
scopes, so upgrading `plezy-artwork-v1` to schema version 2 deletes its old
entries **once**; artwork refills normally. This is a webOS/IndexedDB-specific
security adaptation, not a change to Flutter's image-loading UX.
