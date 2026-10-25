# Plezy for LG webOS TV

**Community port, version 0.1.0 alpha. Target: webOS TV 6.0 (2021) and newer.**

This fork retains [edde746/plezy](https://github.com/edde746/plezy), including its history, license and native apps. The `webos/` directory is a dedicated HTML/JavaScript TV frontend. It ports the server protocols and Mono dark visual language; it does **not** run the existing Flutter screens or mpv on webOS, and is **not yet feature-equivalent** to upstream Plezy.

## Install

1. Install LG's **Developer Mode** app on the TV, sign in, enable Developer Mode and Key Server, and restart when requested.
2. Install Node.js and the [official webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation): `npm install -g @webos-tools/cli`.
3. Run `ares-setup-device`, add the TV as `myTV` (TV IP, port `9922`, user `prisoner`), then run `ares-novacom --device myTV --getkey` and enter the passphrase displayed by the TV's Developer Mode app.
4. Build the updated IPK using the steps below or download the `plezy-webos-ipk` artifact from the latest successful [webOS TV workflow](https://github.com/tvkanters-agent/plezy-webos/actions/workflows/webos.yml). The earlier checked-in 0.1.0 IPK uses the **old** application ID and does not contain these fixes.
5. Install and launch:

```sh
ares-install --device myTV com.tvkdevelopment.plezy_0.1.0_all.ipk
ares-launch --device myTV com.tvkdevelopment.plezy
```

The updated package ID is `com.tvkdevelopment.plezy`. If you installed the old package ID, uninstall `com.tvkanters.plezy` after installing and verifying the replacement. The two IDs have separate TV storage, so existing server sign-ins will not transfer automatically. This is a sideloaded community app, not an LG Content Store release. Developer Mode has a limited session lifetime; keep it enabled using LG's supported tools. See [LG's device setup guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).

## Connect

- **Plex:** choose **Sign in with Plex**, visit `https://plex.tv/link` on another device, and enter the TV's code. The app discovers accessible servers and tries their advertised connections. Alternatively, enter a server URL and a Plex token under **Manual Plex server**.
- **Jellyfin / Emby:** enter the full server URL, username and password. Reverse-proxy path prefixes such as `https://example.net/jellyfin` are supported. Emby URLs should include the API base path if your deployment requires it.
- Use **Servers & settings** to switch between saved servers or remove one. Browsing/search applies to the currently selected server.
- Tokens are stored in the app's local storage. Passwords are never saved. Removing a server clears its local token; it does not revoke the session on the server. For revocation, use the server's device/session management.
- HTTPS with a trusted certificate is recommended. HTTP is available for local servers; credentials and video over HTTP are not encrypted. The app does not disable certificate validation or run a credential proxy.

The TV must be able to reach the selected server. Browser preview and reverse proxies may require appropriate CORS headers, including support for `Content-Type`, `X-Emby-Authorization`, `X-Emby-Token` and the methods used by the API. A network/CORS/certificate failure is shown as a connection error. The app cannot distinguish these causes from a browser's fetch error alone.

## Implemented

- Plex PIN linking, server discovery and manual token connection.
- Jellyfin and Emby username/password authentication.
- Saved servers and switching, library browsing with pagination and server-side sorting/filtering (including unwatched titles), search, show/season/episode navigation and details.
- Continue Watching / Next Up / Recently Added (server-provided hubs on Plex).
- Mark watched/unwatched, resume, periodic server progress reporting and stop reports.
- Native HTML video playback; conservative H.264/AAC MP4 direct play and HLS server transcoding for other media.
- Automatic one-time fallback when direct playback fails, plus **Compatible playback** for manual transcoding.
- Server audio-track and subtitle selection. Selected subtitles are burned in by the server; switching tracks restarts the stream at the current position.
- D-pad spatial navigation, Magic Remote pointer, Back, transport keys and pause on backgrounding.
- Installable IPK, locked build dependencies, automated protocol and browser tests, and a webOS-specific CI workflow.

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

Not yet ported: native Flutter UI parity, music, Live TV/DVR, downloads, playlists, Plex Home user switching, Jellyfin Quick Connect, cross-server search, auto-next episode, intro/credit skipping, advanced filtering, localization, watch parties, tracker/Seerr integrations, HDR/Dolby Vision profiles, configurable HEVC/AV1 direct play, audio passthrough and mpv-specific shaders/subtitle rendering. There is no root/native Flutter embedder requirement.

**Validation:** see [TESTING.md](TESTING.md). Desktop browser tests do not validate LG's decoder, native HLS support, firmware behavior, server compatibility or real account authentication. Real TV/server testing remains required before a stable release. webOS versions below 6 are not supported by this build target.

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

The app is built to `webos/dist/`; the IPK is written to `webos/build/`. The bundle targets Chromium 79 and contains no CDN runtime dependencies. `npm run dev` serves the built app using LG's CLI; desktop Chrome is useful for navigation and MP4 playback, but native HLS availability differs from an LG TV.

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
