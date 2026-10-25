# webOS alpha validation

The original 0.1.0 alpha was validated locally on 2026-10-25 with Chromium 134 (targeting the Chromium 79 engine in webOS 6). The 0.1.1 source currently defines 28 unit and 21 Playwright browser tests; check the latest [webOS TV CI workflow](https://github.com/tvkanters-agent/plezy-webos/actions/workflows/webos.yml) for results. Neither round validates physical LG hardware, live server authentication or the native video decoder.

| Check | Result |
| --- | --- |
| Protocol/core unit tests | 16 baseline passed; 28 tests defined in current source |
| Browser integration tests | 12 baseline passed; 21 tests defined in current source |
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

The legacy 0.1.0 IPK checked into `releases/` predates these fixes. Build the 0.1.1 IPK from `src/` and `public/` with these scripts or use the latest successful CI artifact. The checked-in `releases/SHA256SUMS` applies only to the legacy 0.1.0 IPK, **not** a newly built 0.1.1 IPK. Repackaging may change archive timestamps, so checksum equality across independent builds is not promised.

## Device startup diagnostics (ChatGPT Chat)

A fresh app launch should show the **Welcome to Plezy** screen (or saved-server home) with navigation buttons. If the bundle fails before navigation is built, a visible **Plezy could not start** error appears instead of an empty page after four seconds. The earlier checked-in IPK is out of date; use a fresh build or successful GitHub Actions artifact for the `com.tvkdevelopment.plezy` application ID.

If the TV still fails, inspect the installed app with `ares-inspect --device myTV --app com.tvkdevelopment.plezy --open`. Report the on-screen error and the first non-token-containing JavaScript exception from the console. Do not share account tokens, authorization headers, localStorage contents, or unredacted network requests.

## Plex-first release priorities

1. Verify 0.1.1 startup on a physical webOS TV and Plex PIN linking, including selected server access and stored scoped token. If a blank screen appears, capture the error message from the startup guard; do not capture token-bearing URLs.
2. Verify real Plex libraries, search, Resume, watched state, multi-season episode navigation, sorting, and the fallback Continue Watching shelves.
3. Validate Plex MP4 direct play and Plex HLS transcoding separately. Check seek/resume, device audio/subtitle behavior, backgrounding, progress synchronization, and transcoder cleanup on actual hardware.
4. Improve Plex library discovery and playback based on those TV results before attempting advanced features such as auto-next playback or codec capability detection.

Jellyfin/Emby support remains best-effort. Tests still guard the existing adapters, but Plex functionality takes priority over adding new features to them.
