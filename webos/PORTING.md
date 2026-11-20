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

### Watched/unwatched actions without blank detail frames

Native `WatchActions.setWatched` emits a watch-state event and
`MediaDetailScreen` updates its mounted metadata without displaying a loader.
The webOS detail action now patches the active item's watched/progress fields,
refreshes its existing action buttons and saves the updated detail cache after
server acknowledgement. It does not call the route renderer or reset artwork,
scroll or remote focus. In-flight detail revalidation from before the action is
retired to prevent stale responses from remounting the page during a mark.
The episode More options watched actions use the same mounted-control refresh.
Browser tests assert DOM identity and uninterrupted focus for both paths;
actual LG playback and focus remain hardware-verification items.

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

### Seek play intent on the HTML decoder

Native Plezy preserves playing/paused intent through timeline and chapter seeks. HTMLMediaElement.paused is an observation of the LG pipeline, not a reliable record of that intent during buffering. All webOS committed seeks now retain the pre-seek intent; unconfirmed D-pad movements still never seek. Play is requested at confirmation even if the pipeline reports paused=false/seeking=true, and retried without expiring during slow buffering. A seeked event permits keyframe landing; actual advancing time ends recovery. Explicit Pause, source replacement, errors and backgrounding cancel recovery. The bounded pause/play wakeup is reserved for a landed, frozen decoder. Event-order simulations do not establish physical TV behavior.

### Subtitle clock and controls clearance

Media Captions receives the current media clock on animation frames only while SRT playback is active, plus immediate pause/seek updates; no subtitle parsing occurs per frame. Negative shifted times are retained so a positive delay cannot display a zero-start cue early. Async SRT/ASS construction reads the latest applied delay, never its stale download-time argument. The caption lift uses the actual transport height and is refreshed on resize. ASS canvas positioning stays with libass. These are minimal HTML equivalents of MPV's timed cues and Flutter's measured chrome clearance.

### Regression follow-up: retained rows, watch state and track restarts

Episode menu wrappers retain a separate catalog identity while their play and overflow controls retain stable focus IDs. Catalog reconciliation can therefore preserve unchanged rows and restore the specific control. As with WatchStateNotifier, a server-acknowledged aggregate watched action updates mounted children, their source metadata and saved child pages without remounting artwork; older revalidation cannot undo it. Later loaded children inherit the aggregate action while the route stays mounted.

Source-track PUT follows PlexClient.selectStreams and treats HTTP success as success regardless of an XML/empty body. Rapid changes merge their options and position before awaiting old-session cleanup, and paused track changes pause again after the first resumed decoder frame (LG needs Play to decode that frame). Subtitle offset storage is scoped by the existing account/server fingerprint plus item ID; ambiguous old unscoped offsets are not migrated. Only the latest pending episode Play action may launch after metadata arrives.

### Guarded native Direct Play

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
