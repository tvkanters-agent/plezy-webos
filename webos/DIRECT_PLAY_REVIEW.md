# Native Direct Play review — 16 November 2026

Reviewed the complete Direct Play series from [6504076](https://github.com/tvkanters-agent/plezy-webos/commit/65040768da50f0459a1865ddf6a5f1380bee9dc0) through the v1.10.0 merge, the track correction in [d00ba0c](https://github.com/tvkanters-agent/plezy-webos/commit/d00ba0cb9212d7a8187c360c2c7c0c14dc152b2f), and the [v1.10.2 revert](https://github.com/tvkanters-agent/plezy-webos/commit/55f5e9eccea7e78e3938f393aa786eed43470093). Rebased the replacement on v1.11.4, retaining the intervening seek and subtitle fixes.

The reported intermittent TV failure has no attached decoder log or failing file. These are concrete code defects and compatibility gaps; this review cannot prove which one caused that specific failure.

| Issue | Consequence | Resolution |
|---|---|---|
| Startup timeout was cleared by metadata, before decoded video or clock progression | Native opens that hang without emitting an error could wait indefinitely | Keep a generation/session-scoped deadline until a video-sized, advancing clock, or one decoded frame for a deliberately paused reopen |
| Play rejection only displayed a suggestion when no media error existed | A native rejection could never reach automatic HLS recovery | Non-autoplay/non-abort rejection invokes recovery; autoplay denial remains gesture-driven |
| Global recovery lock covered an awaited reopen/Play promise | A failed replacement HLS session could have its errors suppressed, possibly permanently while Play was pending | Scope recovery ownership to the failed session, release in finally, handle new HLS errors independently |
| Codec gate used aggregate Media codecs rather than stream codecs | An incompatible actual audio/video stream could be approved | Prefer the actual single audio/video stream metadata |
| Missing dimensions/bitrate/depth became zero and passed expanded compatibility | Thin metadata was treated as evidence of support | Require stream details, positive dimensions/bitrate/depth, known profiles, fps and codec level for expanded formats; request streams/checkFiles with normal detail reads |
| Incomplete profile checks omitted level, frame rate, chroma, AAC Main, DTS-HD and PCM constraints | Out-of-matrix sources could be handed to the native decoder | Apply the LG 4.0 matrix and conservative audio/profile checks; unsupported/uncertain cases use HLS |
| Original allowed 4096-wide UHD and UHD MOV/M4V from a broader container list | Eligibility exceeded the documented 3840-wide decode limits/UHD container list | Limit expanded UHD eligibility to documented dimensions and containers |
| Original initially confused Plex-selected audio with the container-native track | Wrong language despite the server selection | d00ba0c partly corrected this; replacement uses HLS whenever multiple audio streams exist, since container default need not be first |
| Original initially ignored server-default subtitles | Subtitles could disappear | d00ba0c corrected this for burn-in; replacement also respects the new independent SRT/ASS renderer and explicit Off |
| LG-only formats were selected in desktop preview too | Desktop browser could be offered codecs it cannot play | Only native webOS gets the expansion; desktop retains its established MP4 path |
| Browser test served WebM under HEVC/MKV metadata | Passing tests were mistaken for codec validation | Explicitly test policy, native MIME/resume contract, and recovery separately; no claim of hardware decoder validation |

## Upstream specification and minimal adaptation

Read the native Plex client playback/stream selection and transcode builders, Plex playback mapper/model, playback initialization service, playback_open.dart, and plex_playback_data_request_test.dart. Native Plezy opens the original part in mpv and carries subtitle sidecars separately. It passes resume to the decoder and keeps a full-title transcoder URL. Retain those semantics. HTML5 on LG cannot replicate mpv's arbitrary codec/embedded track selection, hence the narrow compatibility gate, local text renderer, and existing HLS fallback.

The replacement uses [LG's webOS TV 4.0 AV specification](https://webostv.developer.lge.com/develop/specifications/video-audio-40) and the established [mediaOption native resume mechanism](https://webostv.developer.lge.com/develop/guides/resuming-media-with-mediaoption). Known Dolby Vision metadata stays on HLS; generic HEVC capability does not establish a supported Dolby Vision profile. DTS core and PCM are limited to documented HD containers with explicit compatible audio metadata. Sources with multiple audio streams stay on HLS even when the requested stream is first; this preserves language selection at the cost of the optimisation for those files.

External SRT/ASS file selection, offset application, controls clearance, track-sheet focus, paused reopen intent and full-title seek recovery remain in their existing components. HLS fallback retains the same version, resume point, track IDs and external subtitle asset; renderer failure can still request burn-in. No prefetch or transcoder offset was added.

## Validation boundary

Policy unit tests cover accepted formats, rejected codec/audio constraints, unknown metadata, desktop gating and track semantics. Player unit tests cover native MIME/resume, stale source errors, startup deadlines, frozen clocks, rejected/unresolved Play and failed HLS while recovery is pending. Browser regressions exercise a metadata-only open with a pending Play promise and automatic HLS recovery, plus a failed HLS replacement. The WebM browser fixture validates event/control flow only. Actual MKV/HEVC/DTS/PCM decoding, network buffering and the reported intermittent failure still require the physical C8.
