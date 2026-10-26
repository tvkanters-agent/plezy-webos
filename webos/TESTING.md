# webOS alpha validation

Version **0.2.0 alpha** was validated locally on 2026-10-25 using Node.js 24.22.1 and Chromium 134, with a Chromium 79-targeted bundle for webOS 6+. All **45 unit tests and 28 Playwright browser tests passed**. The release IPK was built with the official webOS CLI. These checks do not validate physical LG hardware, live account authentication or native HLS decoding. CI uses Node.js 22; see the [webOS TV workflow](https://github.com/tvkanters-agent/plezy-webos/actions/workflows/webos.yml) for its separate results.

| Check | Result |
| --- | --- |
| Protocol/core unit tests | 45 passed |
| Browser integration tests | 28 passed |
| Chromium 79-targeted JavaScript bundle | Built successfully |
| Official `ares-package --no-minify` IPK | Built successfully |
| 1920×1080 welcome screen | Screenshot visually inspected |
| Hardware decoder / native HLS | Not tested |
| Real Plex/Jellyfin/Emby authentication and playback | Not tested |
| LG device installation / remote / firmware lifecycle | Not tested |
| GitHub Actions | WebOS workflow runs unit, browser, bundle and IPK packaging checks; check individual commit results |

Unit tests exercise URL validation, reverse-proxy paths, credential-safe error messages, timeout cancellation, navigation geometry, malformed saved state, authentication bodies, Plex PIN mode and discovery, server-scoped tokens, direct versus transcode selection, stream selection, progress units, and transcoder cleanup.

Browser tests use **mock server API responses**, not real servers. They exercise remote-only entry navigation, password handling, libraries/details/back focus, watch-state actions, search, expired credentials, removing saved tokens, Back-key exit confirmation, cancelling PIN polling, and cancelling a pending playback negotiation without resurrecting the player.

The playback lifecycle tests use a real HTML video element and a locally generated black-frame **VP8 WebM** fixture, delivered by the mock media endpoint with HTTP Range responses. This tests resume, seek, play/pause, stop reports, media release and background pause. It deliberately does not claim H.264/AAC or HLS decoding validation: the headless Chromium build lacks the TV's proprietary media pipeline.

## Required TV acceptance checks

- Install the IPK on webOS 6 and at least one recent LG model; verify initial launch and app icon.
- Link an actual Plex account, verify the PIN flow and local/remote server discovery, and select between multiple reachable servers. Try direct manual Plex token entry as a fallback. Jellyfin/Emby are not release blockers.
- Browse a library with more than 60 titles and multiple seasons; test Back focus and scrolling with D-pad and pointer.
- Test H.264/AAC MP4 direct play, incompatible media transcoding, seeking after resume, end-of-video watched state, and a 30+ minute session.
- Select alternate audio and text/image subtitles; confirm burned-in output and resumed position.
- Confirm progress on another client, stop-transcoder cleanup, network loss/recovery, expired tokens and server downtime.
- Background/reopen the app, press remote transport keys, and confirm the exit dialog only appears at the root.
- Check HTTPS certificates and CORS on the actual deployment; do not disable TV or server security to make a failing connection appear successful.

## Reproduce

```sh
cd webos
npm ci
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
npm run package
```

For proxy-configured development machines, exclude `127.0.0.1,localhost` from the HTTP proxy when running the local browser suite. No proxy is required by the app itself.

Use the IPK and `SHA256SUMS` attached to the [0.2.0 alpha release](https://github.com/tvkanters-agent/plezy-webos/releases/tag/v0.2.0). The legacy 0.1.0 package in `releases/` uses the old app ID and predates these fixes. Its checked-in checksum applies only to that legacy file. Independent builds can differ because archive timestamps are not normalized.

## Device startup diagnostics (ChatGPT Chat)

A fresh app launch should show the **Welcome to Plezy** screen (or saved-server home) with navigation buttons. If the bundle fails before navigation is built, a visible **Plezy could not start** error appears instead of an empty page after four seconds. The earlier checked-in IPK is out of date; use a fresh build or successful GitHub Actions artifact for the `com.tvkdevelopment.plezy` application ID.

If the TV still fails, inspect the installed app with `ares-inspect --device myTV --app com.tvkdevelopment.plezy --open`. Report the on-screen error and the first non-token-containing JavaScript exception from the console. Do not share account tokens, authorization headers, localStorage contents, or unredacted network requests.

## Plex-first release priorities

1. Verify 0.2.0 startup on a physical webOS TV and Plex PIN linking, including selected server access and stored scoped token. If a blank screen appears, capture the error message from the startup guard; do not capture token-bearing URLs.
2. Verify real Plex libraries, search, Resume, watched state, multi-season episode navigation, sorting, and the fallback Continue Watching shelves.
3. Validate Plex MP4 direct play and Plex HLS transcoding separately. Check seek/resume, device audio/subtitle behavior, backgrounding, progress synchronization, and transcoder cleanup on actual hardware.
4. Improve Plex library discovery and playback based on those TV results before attempting advanced features such as auto-next playback or codec capability detection.

Jellyfin/Emby support remains best-effort. Tests still guard the existing adapters, but Plex functionality takes priority over adding new features to them.

## Simkl acceptance (Plex only)

- Connect a real Simkl account through **Servers & settings → Connect Simkl** and confirm Simkl write scope is granted.
- Start a Plex movie and verify it appears as currently watching in Simkl. Pause and verify a resumable position; stop under 80% and verify it remains resumable, then stop a different session above 80% and verify watched history.
- Play a Plex TV episode with external show IDs and verify Simkl credits the correct season and episode rather than the episode's own TMDB/IMDb identifier.
- Mark Plex movie/episode watched and unwatched manually, and verify Simkl history updates appropriately.
- Reopen the application with the same Simkl session and verify token refresh still tracks playback after an expired access token; disable the network temporarily and confirm Plex playback remains usable and reports a Simkl warning.
- Confirm disabling Simkl stops new requests. Real-device CORS, certificate, and service behavior remain to be verified.


## 0.2.0 regression coverage and TV follow-up

- Back during delayed stop reporting cannot resurrect a decoder restart; failed track changes still finish the existing Simkl viewing.
- Simkl stops survive reload after failure, retry on a real event or from settings, respect saved quota holds, and cannot leak into a newly linked account. Manual unwatched changes supersede pending stops.
- Intro skips and chapter jumps seek a real HTML video without extra Simkl starts. Verify server-provided intro/credits markers and native HLS seeking on the TV.
- Alternate media versions select the correct direct URL, HLS index and part for track changes, including decoder restarts. Verify differently encoded versions on a live Plex server. Multi-part versions are explicitly unsupported.
- The new tests use mocked APIs and the VP8 fixture described above. No live Plex or Simkl account was used in this validation pass.

## 0.2.1 boot compatibility investigation

On a physical LG TV the previous build displayed `Plezy could not start / Uncaught SyntaxError: Unexpected token {`. The affected commit is **not established** because the earlier builds were not tested on that TV. The prior bundle targeted Chromium 79; this change downlevels its syntax to Chromium 53 and expanding the intended baseline to webOS 4.x / Chromium 53. CI now performs an additional classic-script bundle parse check and tests the on-screen syntax diagnostic. The reported TV version is webOS 4.4.3-22 (Chromium 53 according to LG). The original rejected token's source location is not yet confirmed. Retest using a freshly packaged **0.2.1** IPK rather than the unchanged 0.2.0 release.

For webOS 4.4.3-22, automated compatibility tests must cover older missing browser APIs, not merely Chromium 134 with a Chromium 53 syntax target. WebOS hardware, CORS and video pipeline still require device testing.

The compatibility suite also simulates missing Chromium 53-era APIs in a modern Playwright context, and CSS has a flexbox fallback for the media grid (CSS Grid is newer than Chromium 53). These tests supplement, but do not replace, on-device testing of the webOS 4.4.3-22 target.

## 0.2.2 Simkl device-link regression

Test the exact `POST /oauth2/device` request shape (bare OAuth URL and URL-encoded form client ID/write scope) and `POST /oauth2/token` form grant. A 400 now displays Simkl's sanitized structured error, allowing the real rejection cause to be diagnosed without sharing credentials. WebOS 4.4.3 linking and successful playback tracking remain to be verified on the TV.

## 0.2.3 Plezy UI translation and Simkl JSON

- Simkl device, poll and refresh OAuth requests must carry `Content-Type: application/json` and JSON bodies; preceding webOS releases incorrectly sent URL-encoded form content despite Simkl returning `invalid_request: Invalid JSON request`.
- Inspect the on-device focus border (2.5px inside card), row scrolling (no browser shelves), D-pad scrolling (no row pinned to top), image load performance and compact player timeline/icons against upstream Plezy native Flutter UI. CI tests UI semantics and browser scrolling; GPU/video performance requires testing on webOS 4.4.3-22.

## webOS 4.4.3-22: 0.2.4 acceptance checks

- Confirm Plex sidebar lists all video libraries, can collapse, and preserves individual hide/show choices.
- Confirm Collections and Playlists have usable detail pages and children; verify show seasons, spotlight metadata and On Deck selection.
- Confirm progress does not freeze the TV when opening a 100+ poster library, and the final card is not clipped in horizontal shelves.
- Confirm player audio, subtitle, chapter and quality controls open small custom sheets; Back dismisses a sheet before leaving playback.
- Confirm Simkl title matching now works for Plex media with externally matched IDs, and 404 id_err only suppresses the unmatched title rather than disabling all Simkl tracking.

## Upstream-first Simkl parity

The webOS Simkl adapter now uses the body produced by `lib/services/trackers/simkl/simkl_tracker.dart`: movies `{progress,movie:{ids}}`, episodes `{progress,show:{ids},episode:{season,number}}`; absent external IDs are skipped. It does not query Simkl's catalog or invent matches from titles. Tests assert whole payload equality, ID resolution from Plex show metadata, no write for absent IDs, and no extra request following HTTP 404. Browser OAuth transport remains JSON as a webOS-specific accommodation based on the TV's observed rejection of URL-encoded requests, although native Plezy's Dart HTTP adapter uses form fields. This is an explicitly documented platform difference, not a change to the OAuth field names or grant flow.

## webOS 4.4.3-22: 0.2.5 UI fidelity acceptance

- Confirm partially viewed shows/seasons have remaining unwatched **number** badges rather than a completion tick.
- Confirm show/movie/episode detail metadata appears as separate chips, and the active focused navigation item remains visibly focused.
- Confirm season episodes use correct **episode thumbnail still** in a vertical 16:9 list, with episode number, synopsis and metadata.
- Confirm subtitles show SDH/forced/commentary descriptors and ISO 639 language names.
- Confirm Back from a detail returns to the same library scroll/focus without full page reload; Left from a first-row/first-column media card reaches the active sidebar destination.
- Confirm higher-quality artwork on large detail views and the lack of native browser vertical scrollbar artifacts. These remain hardware checks, not proven by Chromium 134 Playwright.

## Simkl poisoned-queue regression (2026-10-26)

Reproduced the reported `404 id_err; IDs: none; title: present; year: present` on commit `25c27cd39`: seed a persisted title-only stop, then start a movie with valid TMDB IDs. Only the old `/scrobble/stop` was sent; the current `/scrobble/start` never reached the network.

Regression coverage checks upgrade cleanup of that saved row, continuation after an ID-bearing failed stop, exact upstream ID-only movie/episode bodies, no Fribb request, and the dedicated Plex GUID fetch including legacy GUIDs, missing metadata, 404 and server errors. A real browser video test also starts/stops playback with the poisoned queue loaded from localStorage. This is mock API validation, not confirmation of a live Plex/Simkl account.
