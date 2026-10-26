# webOS changelog

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
