# Plezy for LG webOS TV

**Community port, stable version 1.2.2. Primary target: webOS TV 4.4.3 (Chromium 53); webOS 4.x and newer.**

This fork retains [edde746/plezy](https://github.com/edde746/plezy), including its history, license and native apps. **The port is currently Plex-first**; Jellyfin and Emby adapters are maintained on a best-effort basis, without a feature-parity commitment. The `webos/` directory is a dedicated HTML/JavaScript TV frontend. It ports the server protocols and Mono dark visual language; it does **not** run the existing Flutter screens or mpv on webOS, and is **not yet feature-equivalent** to upstream Plezy.

## Install

1. Install LG's **Developer Mode** app on the TV, sign in, enable Developer Mode and Key Server, and restart when requested.
2. Install Node.js and the [official webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation): `npm install -g @webos-tools/cli`.
3. Run `ares-setup-device`, add the TV as `myTV` (TV IP, port `9922`, user `prisoner`), then run `ares-novacom --device myTV --getkey` and enter the passphrase displayed by the TV's Developer Mode app.
4. **Download the [1.2.2 IPK](https://github.com/tvkanters-agent/plezy-webos/releases/tag/v1.2.2)**, build it using the steps below, or download `plezy-webos-ipk` from a successful [webOS TV workflow run](https://github.com/tvkanters-agent/plezy-webos/actions/workflows/webos.yml). Older pre-0.2.1 builds **do not contain the webOS boot compatibility fix**.
5. Install and launch:

```sh
ares-install --device myTV com.tvkdevelopment.plezy_1.2.2_all.ipk
ares-launch --device myTV com.tvkdevelopment.plezy
```

The updated package ID is `com.tvkdevelopment.plezy`. If you installed the old package ID, uninstall `com.tvkanters.plezy` after installing and verifying the replacement. The two IDs have separate TV storage, so existing server sign-ins will not transfer automatically. This is a sideloaded community app, not an LG Content Store release. Developer Mode has a limited session lifetime; keep it enabled using LG's supported tools. See [LG's device setup guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).


### TV startup syntax compatibility

The 0.2.1 build targets **webOS 4.x / Chromium 53**, matching the reported TV version **4.4.3-22**. The earlier 0.2.0 build targeted Chromium 79 syntax. In addition to lower JavaScript syntax, the app now includes compatibility shims for older browser APIs (including AbortController/cancellable fetch, Promise.allSettled/finally, String.padStart and Element.append). These do not change codec, DRM or server support; real-TV validation is still required.

If the screen displays **Plezy could not start**, the next build now includes the script filename, line/column and detected Chromium major version when available. Send that non-sensitive error text and your webOS version for diagnosis. Do **not** share Plex/Simkl tokens or unredacted network requests. Run `npm run build && npm run test:bundle` before packaging to check the bundled classic-script output.

## Connect

- **Plex:** choose **Sign in with Plex**, visit `https://plex.tv/link` on another device, and enter the TV's code. The app discovers accessible servers and tries their advertised connections. If several servers are reachable, choose which one to open. Alternatively, enter a server URL and a Plex token under **Manual Plex server**.
- **Jellyfin / Emby:** enter the full server URL, username and password. Reverse-proxy path prefixes such as `https://example.net/jellyfin` are supported. Emby URLs should include the API base path if your deployment requires it.
- Use **Servers & settings** to switch between saved servers or remove one. Browsing/search applies to the currently selected server.
- Tokens are stored in the app's local storage. Passwords are never saved. Removing a server clears its local token; it does not revoke the session on the server. For revocation, use the server's device/session management.
- HTTPS with a trusted certificate is recommended. HTTP is available for local servers; credentials and video over HTTP are not encrypted. The app does not disable certificate validation or run a credential proxy.

The TV must be able to reach the selected server. Browser preview and reverse proxies may require appropriate CORS headers, including support for `Content-Type`, `X-Emby-Authorization`, `X-Emby-Token` and the methods used by the API. A network/CORS/certificate failure is shown as a connection error. The app cannot distinguish these causes from a browser's fetch error alone.

## Simkl playback tracking (optional)

Open **Servers & settings → Connect Simkl**, then use the code shown on the TV at the Simkl verification URL on your phone. The port uses upstream Plezy's public AUTH V2 device-flow application identifier and requests `media:read media:write`. Simkl's access and refresh tokens are saved in this TV's local app storage, like the Plex token; the app does not proxy credentials. **Disconnect Simkl** clears this TV's saved Simkl session.

When connected, Plex movie and episode playback sends **start**, **pause** and **stop** events with elapsed-time percentages. A stop below Simkl's default 80% watched threshold saves resumable progress; reaching that threshold marks it watched. Plex's own progress reporting continues separately. Simkl receives **no periodic heartbeats**, since its API expects events only. Explicit Plex Mark watched/unwatched actions also update Simkl history. As in native Plezy, Plex must provide usable IMDb, TMDB or TVDB identifiers. Items without external IDs are deliberately skipped rather than matched by title or year.

This is a direct browser-to-Simkl integration. Successful network requests depend on the TV's TLS stack and Simkl allowing this app origin (CORS); no third-party proxy or TLS bypass is included. Real TV/Simkl account validation is still required.

## Upstream fidelity

[PORTING.md](PORTING.md) documents the required Flutter-to-webOS source map, behavior/visual parity expectations, and narrow webOS-only exceptions. Every change must start with the upstream widget/service and its tests; a similar-looking independent implementation is not sufficient.

## Implemented

- Plex PIN linking, server discovery and manual token connection.
- Jellyfin and Emby username/password authentication.
- Saved servers and switching, library browsing with pagination and server-side sorting/filtering (including unwatched titles), search, show/season/episode navigation and details. Plex episodes offer a Next episode button that follows subsequent seasons.
- Continue Watching / Next Up / Recently Added (server-provided Plex hubs, with fallback to Plex library endpoints when home hubs are unavailable).
- Mark watched/unwatched, resume, periodic server progress reporting and stop reports.
- Native HTML video playback; conservative H.264/AAC MP4 direct play and HLS server transcoding for other media.
- Automatic one-time fallback when direct playback fails, plus **Compatible playback** for manual transcoding.
- Plex chapter seeking, intro/credits skip controls and media-version selection.
- Optional Simkl playback tracking, with persisted failed-stop retries and quota cooldowns.
- Server audio-track and subtitle selection. Selected subtitles are burned in by the server; switching tracks restarts the stream at the current position.
- D-pad spatial navigation, Magic Remote pointer, Back, transport keys and pause on backgrounding.
- Installable IPK, locked build dependencies, automated protocol and browser tests, and a webOS-specific CI workflow.

## Artwork caching

Posters, episode thumbnails and detail backdrops are stored in a bounded
IndexedDB cache (up to 80 MiB / 500 entries, least-recently-used eviction).
Cached artwork has **no time-based expiration**: Plex artwork timestamps and
Jellyfin/Emby image tags identify updates when the app next fetches library
or item metadata. Artwork without a trustworthy revision uses ordinary
image loading rather than risking an indefinitely stale cached image.
Recently decoded artwork is also kept in a small memory cache (12 MiB of
compressed images / 48 entries) to avoid blank frames when revisiting a
page. Cast portraits fade in but are not stored persistently. New artwork
always fades in over 300 ms; immediately available decoded memory hits
do not. If the TV disallows IndexedDB or the media server does not permit
fetching image bytes across origins, the app falls back to the existing
ordinary image loader. Stored images can be removed by clearing this app's
TV data.

## Remote controls

| Button | Action |
| --- | --- |
| Arrows / OK | Move focus / activate |
| Back | Close player, go to previous screen, or confirm exit at root |
| Play / Pause | Control video |
| Rewind / Fast-forward | Seek −10 / +30 seconds |
| Left / Right with controls hidden | Seek −10 / +30 seconds |
| Up / Down with controls hidden | Show controls |
| Left / Right on a track selector | Change selection |
| Stop | Stop video and return |

Keyboard preview: Escape acts as Back, Space toggles playback. Text fields keep Left/Right for moving the cursor. Track changes on Plex also update the selected streams on that Plex media part.

## Playback limits and remaining port work

This first target intentionally advertises a conservative profile rather than claiming codecs every LG model can decode. HLS output requests H.264 video and AAC audio at up to 1080p / 12 Mbps; direct MP4 playback can retain the original resolution. A server with transcoding permission and sufficient CPU/GPU capacity is required when the original media cannot direct-play. Seek operates on the native player's media timeline; network and server seek performance varies.

Not yet ported: native Flutter UI parity, music, Live TV/DVR, downloads, playlists, Plex Home user switching, Jellyfin Quick Connect, cross-server search, auto-next episode, multi-part playback, advanced filtering, localization, watch parties, additional tracker/Seerr integrations, HDR/Dolby Vision profiles, configurable HEVC/AV1 direct play, audio passthrough and mpv-specific shaders/subtitle rendering. There is no root/native Flutter embedder requirement.

**Validation:** see [TESTING.md](TESTING.md). Desktop browser tests do not validate LG's decoder, native HLS support, firmware behavior, server compatibility or real account authentication. Real TV/server compatibility still varies by device and configuration, and desktop automation cannot verify hardware-specific behavior. The primary test target is webOS 4.4.3-22 / Chromium 53. This does not guarantee every webOS 4.x device's media codecs or network setup.

## Build and test

From a checkout of this fork, with Node.js 22:

```sh
cd webos
npm ci
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
npm run package
```

The app is built to `webos/dist/`; the IPK is written to `webos/build/`. The bundle targets Chromium 53 and contains no CDN runtime dependencies. `npm run dev` serves the built app using LG's CLI; desktop Chrome is useful for navigation and MP4 playback, but native HLS availability differs from an LG TV.

For TV debugging:

```sh
ares-inspect --device myTV --app com.tvkdevelopment.plezy --open
```

Do not share inspector network captures without removing tokens and server addresses. No telemetry or external analytics are added by this frontend.

## Architecture and upstream

| File | Responsibility |
| --- | --- |
| `src/api.js` | Plex and MediaBrowser API adapters; normalized video metadata; playback negotiation |
| `src/core.js` | URL handling, request timeouts, storage and geometry-based focus |
| `src/player.js` | Native video lifecycle, controls, reporting, transcoder cleanup |
| `src/app.js` | Routes, authentication, TV browsing and focus handling |
| `public/` | Package metadata, HTML, styles and icons |
| `scripts/build.mjs` | Reproducible local bundle and manifest version check |

Source baseline: upstream commit `d1c957ba4aa0addb2ca5474cc7043b50d72d2482` (Plezy 2.24.1 development tree). Protocol references: `lib/services/plex_auth_service.dart`, `lib/services/plex_client/`, `lib/services/jellyfin_auth_service.dart`, `lib/services/jellyfin_client/parts/playback.dart` and `lib/services/jellyfin_playback_urls.dart`. Colors derive from `lib/theme/mono_theme.dart`; icons derive from upstream `assets/plezy.png`.

Upstream native platforms are unchanged. Future upstream merges can use normal fork synchronization; this frontend has its own build and tests and does not change `pubspec.yaml`.

## Platform references

- [LG web engine versions](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)
- [LG appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json)
- [Back button handling](https://webostv.developer.lge.com/develop/guides/back-button)
- [Streaming protocol constraints](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)
- [Package, install and launch](https://webostv.developer.lge.com/develop/getting-started/build-your-first-web-app)

## License

GPL-3.0, as in the repository's [LICENSE](../LICENSE). Plezy and its original assets are the work of upstream contributors. This is an independent community port, not an official LG, Plex, Jellyfin or Emby product. The test WebM is a generated black frame video, not copyrighted movie content.

### Failed Simkl updates

Final stop events are saved with the linked Simkl session before delivery (up to 50). Failed stops survive app restarts and retry on the next real playback action, or through **Retry saved Simkl stops** in settings. Simkl cooldowns are saved too; retrying during a quota hold sends no traffic. Disconnecting Simkl clears its queue. An explicit watched/unwatched change overrides a queued stop for the same title. No periodic scrobble heartbeat or retry loop is used. Force-closing the app before it can record a stop, or unavailable TV storage, can still lose progress.

### Plex chapters and skips

Titles with server-provided chapters offer a chapter selector during playback. Intro and credits markers show a skip button only while the marker is active. These controls seek within the current stream and update Plex progress without creating extra Simkl playback events. Marker availability depends on your Plex server and library analysis.

### Plex media versions

When a title has multiple media versions, choose one on its detail screen before Play, Resume, or Compatible playback. Audio/subtitle changes and decoder fallback retain the selected version. Multi-part files currently show an explicit unsupported message instead of silently playing only the first part; choose a single-part version.

The required browser-engine compatibility target is Chromium 53 for webOS 4.x. Newer browser APIs must be guarded or implemented in `src/compat.js`, not assumed available because modern Playwright passes. The specific webOS 4.4.3-22 TV remains the acceptance device.

### Simkl HTTP 400 at device linking (0.2.2)

The previous webOS port sent form-encoded Simkl OAuth data, which Simkl rejects with HTTP 400 `invalid_request: Invalid JSON request`. Version 0.2.3 sends **JSON request bodies** for `/oauth2/device`, `/oauth2/token` and refresh grants, while keeping the OAuth URLs bare. Plezy's upstream request-field names are preserved; this corrects the webOS browser serialization rather than changing the authentication protocol. The UI now includes Simkl's safe structured OAuth error code and short explanatory message after an HTTP error. If device linking still fails, report only the **visible error text**, never a token, raw response, or device code.

### Native-UI fidelity pass (0.2.3)

The webOS TV frontend is still a platform-specific HTML/JavaScript implementation, not the actual upstream Flutter tree (the Flutter/MPV runtime is not available inside a webOS 4.4 Chromium 53 web application). This pass translates upstream `FocusTheme`, `PlayerFocusDisc`, `VideoTimelineBar` and TV shelf behaviors: small inset focus borders instead of thick outline boxes, 48px transport discs, horizontal timeline with remaining time, chrome that hides during playback, no browser shelf scrollbars, TV D-pad scrolling that keeps the focused grid row in view without snapping it to the top, and near-viewport poster loading for older TV GPU/CPU performance. **This is a partial visual port, not feature or layout parity**; the original Flutter UI remains the reference for future work.

### 0.2.4 Plex-first UI improvements

The webOS frontend now loads the Plex library list into the navigation rail, allows collapsing the rail and hiding individual libraries from **Servers & settings → Library visibility**, and provides the upstream-inspired **Recommended**, **Browse**, **Collections**, and **Playlists** library tabs. Plex collections and playlists use their own API detail/item routes.

Show details include the Plex spotlight backdrop, tagline, year, studio, certificate, rating, summary, genres, credits, cast and season navigation. The player’s right-side controls now open compact audio/subtitle/chapter/settings choice sheets rather than exposing native HTML dropdowns. Horizontal shelf padding was adjusted to keep the final card visible.

To reduce artwork stalls on webOS 4.4 / Chromium 53, Plezy asks Plex for pre-sized thumbnails, loads at most two images concurrently, and yields between small batches of card insertion. Simkl now reads full Plex GUIDs and sends upstream Plezy's exact identifier-only scrobble body. No title search or speculative matching is performed. Full fidelity and hardware playback/scrobble validation remain outstanding; don't treat these changes as a complete Flutter UI port.

### 0.2.5 upstream-reference UI translation

- Show/season poster badges use **remaining unwatched episode counts**, as in Flutter `WatchedIndicator`. Played movies/episodes use progress bars and completed indicators.
- Season episode pages use Flutter `EpisodeCard`-style **landscape 16:9 thumbnails**, a play overlay, synopsis, episode index and runtime/air-date metadata, rather than poster grids.
- Detail pages use the upstream-style separate **metadata/genre chips** and compact, tonal Play/Resume/watch/next controls. Large detail posters and backdrops request higher-resolution server-transcoded artwork than ordinary library cards.
- Plex audio/subtitle selectors preserve original descriptions (e.g. SDH, CC, forced, commentary), codec/channel details and language names, using a browser translation of upstream `TrackLabelBuilder` and the full generated ISO-639 language map.
- Back restores the covered library/home DOM, focus and scroll position without a fresh server fetch. Left from the first artwork column returns focus to the sidebar. Scrollbars are visually hidden on TV as in Flutter's immersive browsing UI, while wheel and remote scrolling remain functional.

**Fidelity still incomplete:** this is a focused translation of the affected components, not the Flutter widget tree running on webOS. Full navigation, detail-screen geometry, action menus and TV-level performance require additional source-by-source porting and physical-device verification.

### 0.2.6 Simkl syncing repair

Install the [0.2.6 release](https://github.com/tvkanters-agent/plezy-webos/releases/tag/v0.2.6). No account relinking is required. Old saved stops with empty IDs are removed automatically on the next playback action or explicit retry; those old records cannot be recovered because they did not save a Plex rating key. A rejected older ID-bearing stop remains retryable but no longer cancels a new viewing's start/pause. Current titles use the same dedicated movie/show ID fetch and ID-only bodies as native Plezy, without Fribb remapping. Local automated validation passes; live TV/Simkl verification remains required.

### Community ratings transport (0.2.7)

Install the full IPK built by `npm run package`; it now contains a native webOS JS
service as well as the UI. A connected Simkl account supplies IMDb, Simkl and MAL
community scores when the title has matching external IDs. The service preserves
Plezy's authenticated redirect/detail flow. Additional MDBList scores continue to
use your configured MDBList account. Desktop `dist/` previews do not provide the
TV's Luna service and therefore cannot perform Simkl community lookups.
