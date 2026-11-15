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
persistence across restarts. LG hardware playback remains to be checked.

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
Jellyfin Trickplay remains outside this Plex-focused port; full TV hardware
verification is still needed.

Unlike Flutter's persistent focus nodes, HTML video decoding on webOS may
blur a transport control to the document body. The player tracks the last
selected transport control and restores it on `playing` without taking focus
from track/chapter sheets. It keeps chrome visible while the user is focused
in that strip, and Left/Right can seek only from the slider or video surface.
Moving focus off the remote timeline finalizes its preview state. The floating
skip prompt is positioned above the *measured* transport chrome instead of
using a fixed bottom offset that overlaps the seekbar on different TVs. Moving
a mouse over the floating prompt must not reveal the controls underneath it:
that changes the prompt's anchor and can make a single click miss entirely.

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
