# webOS changelog

## 0.2.1 alpha — webOS startup syntax compatibility

- Lower the compiled TV app syntax target to Chromium 53 (the supported deployment baseline remains webOS 6+), addressing a reported `Unexpected token {` parser error at startup on a physical LG TV.
- Improve the boot error screen with script filename, line/column and Chromium engine version when available.
- Check the built classic-script bundle in CI; add a simulated script parse-error browser regression test.
- Preserve all Plex, Simkl, chapters and media-version functionality from 0.2.0. Physical device validation remains outstanding.


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
