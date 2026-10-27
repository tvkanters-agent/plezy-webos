# webOS changelog

## 1.5.1 — Faster cached navigation and incremental library refresh

- Predecode only viewport artwork and nearby rows, rather than entire library pages and Home shelves.
- Reconcile changed cards in regular and alphabetically indexed grids, retaining unchanged poster DOM, focus and cached artwork.
- Render Plex titles immediately, without waiting for missing first-character index data.
- Coalesce simultaneous catalog requests while supporting explicit forced refresh and invalidation.
- Skip redundant artwork disk reads and repeated offscreen layout measurements.
- Persist and share an account-scoped collection discovery index with background revalidation and offline fallback.
- Add unit and browser regression tests for request and cache behavior, artwork windows, focus and collection discovery.

## 1.5.0 — Port Plezy skip markers and playback controls

- Port Plex intro/credits markers, nonstandard marker classification and chapter-title fallback with the same matching rules and false-positive safeguards as original Plezy.
- Port Jellyfin native intro/outro media-segment lookup with chapter fallback; use chapter fallback directly on Emby and older servers.
- Match Plezy's separate Off, Button and Auto settings for introductions and credits, the configurable countdown and chapter-pattern preferences.
- Use Plezy's floating skip prompt, progress countdown, 7-second inactivity dismissal and remote-control focus handling. Preserve seek/progress reporting and finalize end-of-title credits through completion rather than an unreliable EOF seek.
- Cover native/chapter marker precedence, pattern matching, TV playback, auto-skip cancellation, decoder resume and Chromium 53 compatibility with automated tests. TV hardware validation is still required.

## 1.4.4 — Reuse cached content without navigation blanks

- Separate compressed artwork retention from decoded bitmap eviction; reserve room for current scrolling alongside landing pages.
- Let disk artwork bypass blocked download slots and recover persistent downloads after transient server failures.
- Prepare cached routes before replacing the visible page, including after restart.
- Persist detail metadata, child lists and cast pages with background revalidation.
- Keep Home for the session; refresh on restart or invalidation, including Back navigation.


## 1.4.3 — Larger, quota-aware library and artwork caches

- Replace artificial title/page/image-count eviction with byte-aware retention. Catalog disk fallback grows to 256 MiB and artwork to 768 MiB, adapting downward only when the browser reports a smaller quota.
- Keep first pages, Plex alphabet indexes and first-viewport artwork prioritized during long library scrolling and subsequent navigation. Retain Home artwork priority while keeping Home metadata fresh on each app launch.
- Correct disk recency when catalog pages are served from RAM, so an actively used first page is not mistakenly treated as old.
- Keep RAM bounded independently: 16 MiB catalog metadata, 24 MiB compressed artwork and 96 MiB estimated decoded bitmap data.
- Avoid expensive periodic full-database scans unless quota pressure is reported; on actual IndexedDB write failure, evict low-priority data and retry once.
- Preserve server-driven artwork revisioning, account isolation and stale-while-revalidate page updates. Add stress tests for hundreds of pages and posters with first-page preservation.

## 1.4.2 — Native-style exit confirmation

- Align the no-backstack exit dialog with Plezy's Mono confirmation styling: centered surface, rounded corners, text/filled pill buttons, focus feedback and dimmed backdrop.
- Preserve the rating sheet's independent styling and restore the originating control's focus when cancelling the exit prompt.
- Add browser regression coverage for dialog geometry, native colors, button styles, D-pad focus and Back dismissal.

## 1.4.1 — Instant Home restoration and consistent content fades

- Restore the preserved Home page directly on same-session rail navigation instead of reconstructing shelves and artwork, keeping decoded images and focus intact.
- Reuse Home instantly after its 45-second cache window while refreshing in the background; rebuild only if updated server content differs, and do not restore state invalidated by playback, watched changes or server switching.
- Avoid a redundant teardown when reselecting the active Home or identical library view.
- Replace the fixed 120 ms page-fade threshold with first-frame readiness. Instantly available pages remain fully visible, while even short real loading gaps fade rather than pop in.
- Apply the fade to cached library/recommendation/alpha pages when artwork rehydration actually takes longer than a frame.
- Cover warm Series visits, repeated Home restoration, back navigation, cache invalidation, and short-delay fades in automated tests.

## 1.4.0 — Persistent library snapshots and live reconciliation

- Persist library directory, Plex and Jellyfin browse pages, Plex recommendations, collection and playlist pages, and Plex alphabet indexes in IndexedDB between app launches.
- Start fresh server requests concurrently with cached reads; display saved metadata immediately and replace only changed content without blanking the screen.
- Preserve D-pad focus, scroll position, alphabet offsets, pagination and revisioned first-frame artwork when fresh results arrive; never animate restored pages as delayed loads.
- Do not persist Home recommendations: each app launch fetches fresh Home shelves while session caching and playback/watch-state invalidation remain intact.
- Partition catalog snapshots by connection/server/account and token fingerprint; remove saved data when a connection is deleted.
- Bound cached catalog metadata to 20 MiB / 120 disk entries and 10 MiB / 40 memory entries; no time-based expiration. Failed refreshes leave stored libraries usable offline.
- Add unit and browser regression coverage for restart hydration, background refresh, stable DOM, offline fallback, focus restoration, account isolation and Plex alphabet restoration.

## 1.3.2 — Faster page navigation

- Reuse recent Home, recommendation, paginated library, alphabet-index, collection and playlist responses rather than repeating network requests on each visit.
- Bound the metadata cache to 32 entries and a 45-second freshness window, with in-flight request sharing and no persisted user-specific catalog responses.
- Invalidate data after playback, watched-state changes, server switching and manual library refresh; prevent obsolete in-flight requests from repopulating the cache.
- Preserve artwork-preparation, lazy loading, focus handling, alphabet-grid behavior and content fade transitions.
- Add browser and unit regressions for cache reuse, refresh, expiry, errors, stale-result races and watched-state invalidation.

## 1.3.1 — Collection sections by library

- Group a Plex collection's movies and shows in distinct sections headed with each source library's actual name.
- Continue paginated results in the correct library grid instead of mixing titles from different libraries.
- Omit empty library sections and preserve navigation, artwork caching, and back-navigation behavior.
- Expand collection grouping regressions and stabilize an existing asynchronous artwork test.


## 1.3.0 — Cross-library Plex collections

- Combine matching Plex collection names across movie and television libraries on the collection detail page.
- Stream titles in original collection order, suppress duplicate Plex item IDs, and preserve individual detail navigation.
- Keep the primary collection usable when another library cannot be enumerated or read.
- Add unit and end-to-end coverage for pagination, library matching, deduplication, and unavailable libraries.

## 1.2.9 — Remember sidebar focus

- Return to the last focused navigation destination when pressing Left from the main content area, including cast rows.
- Default to Home before a sidebar item has been focused, or when the remembered destination is unavailable.
- Preserve focus history through sidebar re-renders and cover the behavior with browser regression tests.


## 1.2.1 — Stable cast heading while loading

- Reserve the cast member's title-count line using the same text metrics as the eventual count, with no fixed line-height or pixel reservation.
- Confirm the placeholder grows with font changes and the header stays stable when the filmography arrives.


## 1.1.4 — Reduce browsing layout work

- Reuse bounds within D-pad decisions and avoid candidate scans on first-poster sidebar exits.
- Bound alphabet-grid sizing to the first row plus one card, preserving jump/focus alignment.
- Batch artwork measurements before starting image loads, retaining concurrency and fades.
- Replace pending library focus polling with a completion handoff; preserve cancellation and empty-library navigation.
- Add deterministic performance regression checks alongside existing navigation and playback tests.

## 1.1.3 — Stable alphabet row alignment

- Share grid decoration clearance between alphabet jumps and D-pad focus reveal.
- Keep the previous row offscreen and return to the selected row on the first Left.
- Cover forward/backward jumps and focus movement in grid and TV flex layouts.

## 1.1.2 — Alphabet jump placement and focus

- Align alphabet jumps to the actual top of the media grid rather than adding a full page-padding inset. Previously this exposed a preceding row.
- Port Plezy's return-to-grid selection by targeting the last item in the requested row, even when another row is partially visible. A single Left/Back press now selects the intended row.
- Prevent the normal 32px D-pad focus margin from shifting the top row downward after alphabet navigation.
- Correct the first-visible-index calculation and cover scroll alignment, row selection and stable focus with browser regressions.


## 1.1.1 — Artwork loading and alphabet scroll layout

- Fade in asynchronously loaded album and poster artwork over 300ms, matching Plezy's OptimizedMediaImage; instantly reveal images already in memory cache.
- Display a clean opaque surface during pending loads instead of Chromium's white broken-image border, with a subdued unavailable-artwork icon when loading fails.
- Match the native alphabet bar's bottom alignment. Keep the grid's top inset after letter jumps, preventing a vertical shift when focus returns to a top-row card.
- Correct the first-visible-row letter calculation, and add browser regression tests for artwork, placeholders, letter jumps and return focus.


## 1.1.0 — Plezy alphabetical library navigation

- Port the original TV alphabet rail, overscan inset, current-letter indicator, D-pad/pointer navigation and return-to-grid focus.
- Fetch native Plex first-character buckets; navigate by cumulative media offsets with a bounded sparse grid, including unloaded titles.
- Port Jellyfin/Emby's A–Z/# prefix filtering through NameStartsWith/NameLessThan; selecting the same letter again clears its filter.
- Preserve the library alphabet bar, items, scroll position and focus across detail navigation.
- Add upstream-derived unit tests, browser regressions and Chromium 53 adaptation notes. LG hardware validation remains outstanding.


## 1.0.0 — First stable webOS release

- Promote the Plex-first LG webOS TV port from the 0.2.x alpha series to its first stable release, retaining the existing application ID and settings.
- Include Plex browsing and playback, resume at decoder open, library/detail UI, chapters, subtitle/audio selection, cast portrait fallbacks and optional Simkl tracking/community ratings.
- Keep the Chromium 53 / webOS 4.x compatibility target and package the native Simkl catalog service in the installable IPK.
- The GitHub Actions release workflow now publishes 1.x versions as stable releases after successful unit, browser, compatibility and packaging checks; 0.x versions remain prereleases.
- Feature parity with the upstream Flutter application is incomplete. Physical LG TV/decoder and live account behavior cannot be established by CI alone.

## 0.2.10 — Cast portrait fallbacks

- Use Plezy's filled person placeholder in cast tiles and actor profiles.
- Handle absent URLs, images being loaded, and failed image requests without a browser broken-image indicator.
- Cover both views with mocked image failure browser regression; LG TV validation remains outstanding.

## 0.2.9 — Smooth playback exit

- Preserve the mounted detail page and remote focus when stopping playback; avoid a blank re-render between two copies of the screen.
- Refresh Resume/Play, restart and watched actions in place using updated server metadata.
- Add browser regression coverage for DOM continuity, focus and resume; physical LG verification remains outstanding.

## 0.2.8 — Native resume at load

- Pass the saved playback position to LG mediaOption before loading direct or HLS media, avoiding the initial load-then-seek buffering cycle.
- Remove the Plex transcoder offset workaround; preserve the full-title timeline as upstream Plezy does.
- Remove stale native sources on stop/reopen and retain the resume position in startup progress reports.
- Validated with 88 unit tests, 69 browser tests, Chromium 53 bundle checks and IPK packaging. Native LG buffering still requires device verification.

## 0.2.7 — Authenticated community ratings

- Port Plezy's Simkl redirect → title-detail lookup with the connected account's
  access token and shared token refresh. The previous unauthenticated request
  returned `401 user_token_required`.
- Bundle a small webOS JS service to read the unfollowed redirect Location;
  browser fetch cannot expose it. Preserve IMDb, Simkl and MAL community scores
  alongside Plex/MDBList scores in the metadata bubble.
- Replace misleading public-endpoint fixtures with authenticated movie/anime,
  refresh, service transport and rendered chip regression tests.
- Validation: 85 unit tests, 68 browser tests, Chromium 53 bundle and IPK build.
  Actual LG TV service startup and authenticated API responses remain unverified.

## 0.2.6 alpha — Simkl queue and upstream ID parity (2026-10-26)

- Fix a reproduced port bug where a saved title-only stop returned `404 id_err` and prevented valid current playback from sending start/pause.
- Skip/remove unusable legacy stops; isolate failures for older identified titles from current playback, while retaining account and quota protections.
- Fetch Plex movie or parent-show IDs using native Plezy's dedicated `includeGuids=1` query and preserve legacy GUID support.
- Restore upstream ID-only payloads and skip unmatched items. Remove title/year guesses and the unnecessary Fribb download/remapping (`needsFribb=false` in native Simkl).
- No Simkl reconnect or Plex metadata edits are needed for the queue repair. Old ID-less history cannot be recovered from records that lack a Plex rating key.
- Validated 67 unit tests and 53 browser tests, plus Chromium 53 bundle and IPK checks. Real TV/account verification remains outstanding.

## 0.2.5 alpha — upstream WatchedIndicator, EpisodeCard and detail actions

- Port show/season unwatched counts; episode lists now show 16:9 episode stills, synopsis and metadata.
- Translate detail hero metadata/genre chips, compact tonal action pills and correct show/season Play actions.
- Fetch higher-resolution art when it is shown large while retaining small poster requests in browsing grids.
- Preserve original subtitle descriptions (including SDH/forced/CC) and audio details, with upstream ISO 639 language mappings.
- Hide browser-default vertical scrollbars; distinguish focused active navigation; preserve covered page DOM, focus and scroll on Back; fix Left-to-sidebar boundaries.
- The webOS application is still not feature/visual parity with native Plezy. Verify on LG webOS 4.4.3.


## 0.2.4 alpha — Plex library rail, show details and player fidelity

- Fetch Plex libraries directly into the original-style navigation rail; support compact rail and per-library hidden preferences.
- Translate Plex Recommended/Browse/Collections/Playlists pages with working collection/playlist routes.
- Add richer TV show detail spotlight, metadata and season navigation.
- Replace browser player options with compact right-hand control discs and custom choice sheets.
- Reduce Chromium 53 artwork freezes using server-resized posters, two concurrent image loads and batched DOM work; correct home-carousel end padding.
- Enrich Simkl movie GUIDs and report unmatchable 404 id_err items without repeated requests.
- Continue to prioritize Plex. Real-device UI performance and Simkl behavior still need validation.



## 0.2.3 alpha — Simkl JSON requests and Plezy TV UI alignment

- Correct Simkl OAuth V2 device code, polling, and refresh to JSON request bodies; retain original Plezy grant fields, write scope, and sanitized error UI.
- Translate focus size/border/glow, video timeline and transport controls from upstream Flutter widgets, rather than using default TV browser outline and button styling.
- Remove browser scrollbars from horizontal shelves, preserve scroll positions in library D-pad navigation, and lazily request on-screen artwork to reduce webOS 4.x workload.
- Keep player title/header in sync with auto-hide, and retain controls, Plex playback and progress-scrobble APIs.
- Browser/UI acceptance still requires checking on the LG webOS 4.4.3-22 device.



## 0.2.2 alpha — Simkl device linking

- Match upstream Plezy's Simkl V2 device-code HTTP request: no application-identity query parameters on OAuth endpoints; send the client ID and requested write scopes as form fields.
- Display sanitized OAuth rejection codes and messages instead of an uninformative HTTP 400.
- Add an explicit OAuth request-shape regression and an HTTP 400/error-redaction test.
- Keep webOS 4.4.3 / Chromium 53 as the primary device target. Real-account confirmation pending.


## 0.2.1 alpha — webOS startup syntax compatibility

- Lower the compiled TV app syntax target to Chromium 53 (now targeting the confirmed webOS 4.4.3 / Chromium 53 device), addressing a reported `Unexpected token {` parser error at startup on a physical LG TV.
- Improve the boot error screen with script filename, line/column and Chromium engine version when available.
- Check the built classic-script bundle in CI; add a simulated script parse-error browser regression test.
- Add runtime compatibility for missing older browser APIs, including AbortController, Promise.allSettled/finally, String.padStart and Element.append. Preserve Plex, Simkl, chapters and media-version functionality from 0.2.0. Physical device validation remains outstanding.


## 0.2.0 alpha — 2026-10-25

Plex playback and optional Simkl tracking milestone, incorporating the 0.1.1 ChatGPT Chat continuation and focused ChatGPT Work fixes.

- Plex library sorting/unwatched filters, fallback home shelves, multi-server selection and cross-season Next episode navigation from 0.1.1.
- Simkl V2 device linking and automatic movie/episode play, pause, stop and manual watch-state updates from 0.1.1.
- Cancel pending stream restarts on Back; finish the Simkl viewing even when a track change fails.
- Persist failed final Simkl stops, retry on a later playback action or from settings, and honor quota cooldowns across reload. Keep delayed responses isolated from newly linked accounts.
- Plex chapter selector and intro/credits skip controls using server-provided metadata.
- Media-version selection retained through resume, compatible playback and track changes. Multi-part files produce an explicit unsupported message.
- Application ID `com.tvkdevelopment.plezy`; target webOS 6+; release package version 0.2.0.

Validation: 45 unit tests and 28 browser tests passed locally. Chromium 79-targeted bundle and official CLI IPK built successfully. Browser APIs are mocked; video tests exercise a real HTML video element using a VP8 WebM fixture. Physical LG decoding, native HLS, real Plex/Simkl authentication and CORS still require device acceptance. See [TESTING.md](TESTING.md).

Download the IPK and SHA256SUMS from the GitHub release. The old checked-in 0.1.0 IPK uses a different app ID and is obsolete.
