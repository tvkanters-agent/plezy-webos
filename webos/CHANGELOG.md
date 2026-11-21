## 1.22.37 — Remove Plex date-sort pagination

- Remove offset pagination from Plex Recently added and Release date. Each sort opens one complete library snapshot, including when browsing a saved library offline.
- Keep scrolling and remote focus local to the visible rows. A truncated server response offers Retry and leaves the last complete snapshot available.

## 1.22.36 — Synchronize covered season details after a watch change

- Apply Plex watch and unwatch acknowledgements to matching season pages on the Back stack.
- Keep restored episode badges, progress, More options and later pages consistent with the season action.

## 1.22.35 — Verify Plex date-sort page boundaries

- Verify the preceding page against the same Plex response as each live successor, then repair moved boundaries in place.
- Keep coherent cached pages browsable while Plex refreshes them, including when the first request stalls.

## 1.22.34 — Fix Plex date-sort page ordering after refresh

- Keep pending page requests separate when Plex shifts the order twice during browsing.
- Reconcile first-page updates completed while the library tab was detached.
- Discard successor cache entries from older builds that could have saved the wrong ordering.

## 1.22.33 — Synchronize episode watch state on reopened seasons

- Apply delayed season watch and unwatch acknowledgments to the reopened season's episode badges, progress and More options.
- Keep loaded and pending episode pages consistent in the saved catalog.

## 1.22.32 — Publish webOS pre-releases after multi-commit pushes

- Compare the version before the master push with the version at the tested tip, so release notes committed after a version bump can ship in the same push.
- Skip separate same-version pushes and use the original push SHAs on retries.

## 1.22.31 — Fix watched action on reopened Plex details

- Reconcile delayed Plex watched/unwatched acknowledgments with the reopened detail of the same title, including its accessible button label.
- Ensure watch actions follow the currently displayed command even if cached media state changes behind the UI.
- Keep unrelated titles and accounts unchanged and preserve Simkl synchronization after Back.
- Cover both watch directions with Playwright regressions.

## 1.22.29 — Restrict release publication to the version-bump commit

- Validate every master commit, but only publish its IPK when that commit increased the app version compared with its first parent.
- Keep same-version follow-up runs from racing the intended version-bump publisher for a tag.
- Preserve release retries, fail if parent history is missing, and test bump/follow-up/retry scenarios.

## 1.22.27 — Fix Back navigation during pending playback and detail updates

- Cancel queued native HLS replay when Back or another navigation leaves its originating detail view, without reordering Plex Stop/teardown or breaking immediate replay.
- Complete Plex watched/unwatched cache persistence and Simkl history sync after Back on the same account, without touching disposed detail controls.
- Remove empty community-rating pills in detached detail snapshots when provider lookups return no ratings.
- Add browser and unit regressions for the interrupted HLS replay, delayed watched/unwatched acknowledgments, and empty ratings before, during, and after Back.

## 1.22.26 — Preserve queued webOS releases on consecutive merges

- Isolate every master workflow run in its own concurrency group so rapid merges cannot discard a pending version's validation and publication.
- Continue cancelling superseded pull-request runs, and retain the full master release QA gate.
- Add a regression guard for workflow concurrency and release prerequisites.

## 1.22.25 — Fix replay after stopping a native HLS resume

- Retire the LG video element when Stop interrupts HLS startup so replay opens with a fresh decoder.
- Release the resume frame as soon as LG reports the requested position, even when its playback clock updates after the first playing event.

## 1.22.24 — Prevent interrupted HLS startup from poisoning replay

- Retire an interrupted Plex HLS transcode session before starting playback again, without delaying Stop itself.
- Stop stale sessions whose playback negotiation finishes after Stop; cap the replay handoff to three seconds if Plex hangs.
- Preserve normal decoder restart and seek behavior; test interrupted startup, delayed Plex Stop, and hung cleanup.

## 1.22.23 — Bound Plex date-sorted library grids

- Mount only the visible and nearby poster rows in Recently added and Release date.
- Preserve cached pages, scroll position and remote focus across pagination and detail navigation.

## 1.22.22 — Stop background playback during negotiation

- Capture Pause intent when the app is hidden before server playback negotiation finishes.
- Preserve the paused state through audio-track reopening and resume-frame seeks on LG.
- Verify pending starts, resumes, track changes, stationary background time and explicit foreground Play using Playwright.

## 1.22.21 — Reconcile Plex Recommended shelves without full remounts

- Update changed Recommended cards incrementally, preserving unaffected shelf/card nodes, artwork and focus.
- Preserve vertical and horizontal scroll positions and reconcile additions, removals and reordering.
- Use the same incremental refresh on restored cached tabs, including after reload.
- Add browser regression coverage for DOM/artwork identity and persistence.

## 1.22.20 — Bound MDBList requests

- Time out stalled MDBList key verification and title-rating requests, including response-body stalls, and restore retryability.
- Keep available Plex and Simkl scores visible after provider failure, without caching temporary MDBList failures.
- Add regression coverage for cancellation-resistant requests and provider recovery.

## 1.22.19 — Reconcile Resume after asynchronous Stop

- Keep Stop and decoder cleanup immediate while waiting separately for the final playback report to settle before refreshing the mounted detail metadata.
- Prevent old report/metadata results from overwriting newer playback sessions, navigation state, or saved detail snapshots.
- Verify delayed and failed progress reporting plus saved Resume updates with unit and browser regressions.

## 1.22.18 — Parallel, scoped webOS CI

- Parallelize unit, bundle/IPK and two browser E2E shards while preserving the final QA gate.
- Avoid duplicate PR/push runs and cancel superseded PR revisions, but never cancel master releases.
- Run feature-specific E2E only for isolated changes; use full browser coverage for shared/unknown changes and every master build.
- Add selection regressions and safe merge instructions.

## 1.22.16 — Fix Plex series Shuffle

- Shuffle now traverses seasons and paginated episodes in Plex series rather than treating season rows as unplayable.
- Sample episodes uniformly without building a full in-memory queue; keep season Shuffle within the chosen season.
- Cancel pending Shuffle on navigation or another playback launch; handle empty shows without opening the player.
- Add browser/unit regressions covering multi-season shows, pagination, empty seasons and cancellation.

## 1.22.14 — Remove credentials from persisted artwork cache

- Persist account-scoped artwork fingerprints instead of storing authenticated Plex/Jellyfin/Emby image URLs in IndexedDB keys.
- Remove a disconnected server's persisted and in-memory artwork without deleting other servers' caches, and reject stale in-flight work after removal or credential replacement.
- Clear unsafe legacy URL-keyed artwork on first IndexedDB schema upgrade and add browser/unit regression tests.

## 1.22.13 — Prevent slow playback reporting from blocking Stop and restart

- Coalesce unsent progress heartbeats; send final stopped position without waiting behind a growing queue.
- Release decoders and begin server-side transcode teardown without waiting for a slow server.
- Cancel obsolete Plex/Jellyfin requests, preserve Simkl tracking and add regression tests.

## 1.22.12 — Cache personal Simkl ratings

- Reuse five-minute, account-scoped Simkl personal-rating snapshots for movies, shows and anime instead of downloading full lists for each detail page.
- Coalesce concurrent lookups, index ratings by external IDs, and cache both ratings and misses.
- Refresh snapshots after successful rate/unrate or expiration, discard them on disconnect/relink, retry failed reads and preserve data across normal token refreshes.
- Add tests for concurrency, account isolation, category fallbacks, errors and expiry.

## 1.22.11 — Fix Plex action timeouts and large-season navigation

- Route Plex mark watched, mark unwatched and rating requests through the app's existing 15-second cancellable HTTP transport; accept empty/XML success responses without JSON parsing. Failed requests remain retryable without changing local watch state or syncing Simkl.
- Remove the artificial 1,000-item pagination cutoff when finding the next Plex episode, so unusually long seasons do not jump to a later season before reaching the actual end.
- Add regressions for Plex status/timeout failures, retries, long seasons, gaps in episode indices, short pages and empty pagination responses.

The network and navigation cases are covered by automated tests; LG TV and live Plex server verification remains outstanding.

## 1.22.9 — Resume playback after seeking from paused

- A committed timeline, chapter, pointer or skip seek now requests playback even when the media was paused beforehand. LG's paused decoder flag no longer suppresses seek recovery during buffering.
- Explicit Pause during a seek preview or after committing the seek cancels the pending auto-resume. Canceling an unconfirmed remote preview still preserves the original paused state.
- Add unit and browser regressions for paused seeks, preview cancellation, and delayed buffering.

Actual LG decoder recovery still requires testing on the TV.

## 1.22.6 — Faster ASS subtitles on initial resume and after seeks

- Begin reading verified, persistent ASS subtitle and font caches and warming the libass renderer while the native video pipeline resumes. Previously the player waited for the seek to finish before even checking its cached subtitles. Cached ASS preview now targets the saved resume position rather than 0:00.
- Preserve decoder-first network priority on the LG C8: a cache miss holds native MKV byte-range requests until the first decoded frame, and pending reads are canceled if the player switches tracks or closes.
- Prioritize newly extracted ASS events intersecting the current playhead or next eight seconds when a large subtitle track is still importing; on seeks reprioritize pending events instead of waiting for unrelated scenes and vector signs.
- Update libass to the precise seek timestamp before requesting a forced paused redraw, including when the decoder is underbuffered.
- Add tests for cached startup at a saved timestamp, cancellation and seek-event priority.

Retains v1.22.5's versioned worker assets and persistent font cache. Hardware-specific buffering timing needs testing on LG webOS 4.4.

## 1.22.5 — Fix broken ASS worker/font loading after IPK updates

- Package the ASS worker, wrapper and all JavaScript chunks under a unique versioned asset directory. Previously 1.22.4 changed the worker chunk format while retaining the same URLs; stale scripts from previous installations could be mixed into an invalid worker on webOS, leaving custom ASS fonts unloaded.
- Restore sequential chunk loading specifically for the large legacy worker on Chromium 53, and validate every indexed Blob rather than accepting sparse arrays. This keeps the other 1.22.4 performance and synchronization improvements.
- Do not rename, invalidate or clear existing ASS font and subtitle-track IndexedDB stores. Cached fonts remain usable and missing fonts can still be read from the original MKV.
- Verify versioned worker resources at build time and cover version-specific asset URLs in browser tests.

TV-specific asset caching and font behavior still require verification on LG webOS 4.4.

## 1.22.4 — Improve ASS startup reliability and synchronize renderer timing

- Use the player’s authoritative decoded-video clock exclusively while styled ASS is active. The bundled SubtitlesOctopus no longer sends a second set of conflicting timeupdate, pause, seek and buffering messages; its resize/metadata listeners remain attached.
- Apply pause and playback-rate state before updating the libass worker clock, preventing a transient frame rendered with the previous seek or rate.
- Do not send incremental ASS event/style messages until the worker finishes loading its track; reuse its ready style response.
- Start embedded ASS extraction without the extra 200 ms timer once playback supplies its first frame, including paused opens and dimensionless native video. Preserve the native resume/first-frame gate, compatibility mode and SRT timing behavior.
- Load bundled legacy worker assets in bounded parallel groups and preserve their assembly order. Detect the first ASS frame from libass's image payload so tiny signs cannot be discarded by a low-resolution canvas probe.
- Add regression tests for cold/warm worker clock ownership, incremental event readiness, paused ASS opening, native zero-dimension video and tiny-sign visibility.

Real LG TV seek timing and first-render latency remain to be verified.

## 1.22.3 — Reduce ASS flicker, timing latency and cached-track startup

- Invalidate stale ASS canvas pixels at the start of a video seek, including paused seeks that land between subtitle cues, without blanking ordinary playback.
- Accept same-millisecond libass canvas frames so a paused seek cannot lose the one blank frame that clears stale text. Test forced timestamp collisions in real legacy libass animation.
- Fix redundant SubtitlesOctopus canvas resets on no-op resizes, without delaying intentional blank frames after seeking.
- Wait until libass responds to a style query before marking a new worker initialized; follow decoded video time every 100 ms and avoid redundant rate messages. Preserve native subtitle seek-state handling.
- Render current and near-future cues from a cached embedded ASS track first, then append distant events in bounded worker batches without reparsing a full script upfront. Reuse a warm worker's exact existing track when possible.
- Keep the existing persistent font cache, custom styling and independent subtitle toggles. Add unit tests for sign-layer preview selection and an end-to-end test for no-op canvas resize.

## 1.22.2 — Restore carried audio selection in Plex HLS playback

- Pass the matched episode-specific audio stream ID to both compatibility HLS and enhanced SRT/ASS HLS URLs, mirroring upstream Plezy's Plex transcode selection and preserving the existing part-level stream selection.
- Keep subtitle matching and the independent enhanced text subtitle asset unchanged. Add regression coverage for selections carried across seasons where the old stream IDs have been reused by different languages, for both SRT and ASS.

## 1.22.1 — Fix permanent missing ASS fonts on cached MKV tracks

- Do not save completed ASS tracks without a verified, nonempty font manifest. Existing 1.22.0 records with missing verification or no attached fonts are re-extracted rather than replayed permanently with fallback fonts.
- Propagate failed MKV font attachment reads instead of converting errors into an empty font list. The existing Plex subtitle fallback remains available if extraction genuinely fails.
- Reject truncated attachment metadata and oversized skipped fonts rather than silently displaying the wrong glyphs. Add regression tests for failed font reads and invalid cache entries.

## 1.22.0 — Warm ASS workers, cached tracks and resilient seek clocks

- Keep the compiled legacy/WASM libass worker and its registered fonts idle between enhanced ASS sessions, without decoding or video listeners. Reuse it for sibling episodes whose cached font bytes match; dispose it when switching to compatibility playback or a different font set.
- Persist each completed embedded ASS track separately from its fonts. Reopening the same Plex part bypasses the MKV seek index and subtitle cluster reads, even after an app restart; no Plex authentication URLs are saved.
- Follow the actual video position between sparse native timeupdate events, including paused seeks. Clear stale buffering state after playback progresses or seeking completes, and force a redraw after a seek so cached worker frames cannot remain blank.
- Wait for the libass worker's actual runtime-ready event, not the first log message. Test real rendered signs and playback switches with the same font but different subtitle scripts.

## 1.21.0 — Incremental ASS events and persistent font reuse

- Start an MKV ASS preview after the closest indexed cluster instead of waiting for twelve, and append subsequent events in one worker message per batch. Keep the original ASS styles and signs without recreating libass's track after each partial read.
- Fetch embedded fonts concurrently with subtitle-index/cluster reads. Cache font bytes in memory and IndexedDB so sibling episodes and app restarts avoid fetching the same attachments again, with checksum/name/size/scope validation and storage-pressure recovery.
- Synchronize ASS after seeking, waiting, pause, play and playback-rate changes. Time-stamp messages at the decoder to prevent a busy worker from treating an old position as fresh.
- Test actual WASM/legacy libass rendering, delayed-cluster previews, file-origin startup, worker batching, persisted fonts after page reload, decoder timing and legacy playback separation. LG C8 timing and font performance still require physical validation.

## 1.20.0 — Independent SRT/ASS playback modes

- Replace Enhanced playback with separate SRT and ASS/SSA switches, preserving existing users' single-switch choice for both formats.
- Select the historical Plex HLS/burn-in path when the selected format's switch is off, before any video decision, subtitle extraction, or renderer load. Only the enabled selected format uses the enhanced transport and overlay.
- Switch between enabled local SRT and ASS tracks without reopening video; switching between local subtitles and Plex burn-in still replaces the video stream. Explicitly select the requested Plex track before burn-in, including a server-default selection.
- Keep subtitle sync unavailable for burned-in or absent subtitles and preserve native one-buffer resume.

## 1.19.4 — Start nearby MKV SRT cues after decoder Play

- Start the first embedded MKV subtitle read shortly after the hardware decoder's `playing` event instead of waiting for video dimensions and 0.1-second clock progress. Preserve the existing full startup gate and decoder-failure recovery.
- Guard each read by playback generation and selected session, so late timers cannot trigger duplicate reads or resume-position mistakes.
- Add an opt-in diagnostic measurement for the actual decoder playing event, to distinguish first-frame gating from network/renderer latency.

## 1.19.3 — Validate Plex byte ranges by actual payload size

- Trust a verified Content-Range over an inflated Content-Length on Plex partial responses. Native webOS still aborts transfers whose actual payload exceeds the requested range.
- Distinguish inflated header lengths from oversized transfer bodies in opt-in diagnostics, so future failures identify the relevant layer.

## 1.19.2 — Early Plex sidecar after MKV decoder retry

- When the decoder restarts with MKV range reads disabled, begin the Plex subtitle sidecar immediately instead of waiting for the replacement video's first-frame gate.
- With general Diagnostics enabled, identify the subtitle source and MKV read failure in the on-TV panel. Keep all timing and diagnostic reporting inactive when disabled.

## 1.19.1 — General Diagnostics setting

- Place the opt-in diagnostics switch under Settings → About, where it can gate SRT timing and future diagnostic features. Remove the SRT-specific playback-setting toggle.
- Keep diagnostics inactive by default, and preserve the old preference for users who explicitly enabled it in v1.18.0.

## 1.19.0 — PixiJS 4 SRT rendering

- Render enhanced SRT/VTT subtitles with PixiJS 4.8.9 CanvasRenderer. Rasterize text and rounded outlines at 2× resolution for sharp boundaries, preserving Plezy's font, color, border, positioning, margins, bold and italic preferences.
- Retain timed/overlapping cue delivery, inline emphasis, multi-line wrapping and subtitle sync while avoiding per-frame texture regeneration or DOM/SVG cue measuring.
- Load PixiJS only for enhanced text subtitles; compatibility playback and ASS/libass behavior remain separate. Bundle the renderer and its MIT license in the IPK.
- Cover timing, text formatting, colors, border pixels, layout, library packaging and renderer lifecycle with targeted automated tests. LG C8 hardware validation remains outstanding.

## 1.14.3

- Use Plezy's Generic Plex profile for the MPEG-TS HLS target to avoid a duplicate target in the Chrome profile.
- Request an independent HTTP sidecar for embedded text subtitles in both Direct Play and HLS playback.

## 1.14.2

- Start MKV subtitle reads after the video decoder opens. Keep video playing if the selected embedded subtitle is unavailable.
- Cancel MKV range transfers on webOS and retry playback once with the separate Plex subtitle endpoint if the decoder fails during a range read.

## 1.14.1

- Render indexed MKV subtitles near the playback position as they arrive. Read compressed ASS/SRT and cue indexes without relative block offsets.

## 1.13.2

- Read indexed MKV subtitles directly from Plex media byte ranges so embedded SRT and ASS sync can work even if the Plex subtitle endpoint fails.

## 1.13.1

- Render embedded Plex SRT and ASS/SSA locally so subtitle sync works without forcing video burn-in.
- Explain when Plex has to burn a subtitle into the video and sync is unavailable.

## 1.13.0 — Pre-play audio and subtitle selection for all video details

- Choose source audio/subtitle tracks in movie More options before playback, respecting the selected Plex media version.
- Choose from show/season More options using the episode their Play action would launch, carrying the language/track intent to matching sibling episodes.
- Keep movie choices isolated to their title and version; do not request server stream changes until Play. Preserve the existing episode picker, focus restoration and session-only preferences.
- Cover versioned movie stream IDs, show/season carry and real browser navigation.

## 1.12.1

- Fix subtitle sync on Chromium 53 by supplying the Object APIs needed by Media Captions, and match Plezy's Plex sidecar URLs (codec extension and UTF-8).
- Bundle libass's required default font, omitted from its npm package, with its license and a build-time asset check.
- Exercise visible SRT cues and actual WASM/legacy libass canvas output through live positive/negative/reset sync adjustments.

## 1.12.0 — Guarded native Direct Play

- Restore validated AVC/HEVC MP4/MKV Direct Play on native webOS within the C8 decode limits.
- Use actual stream codecs and check profiles, levels, frame rates, chroma and audio constraints. Keep incompatible/uncertain expanded formats and multiple embedded audio tracks on HLS.
- Recover metadata-only/frozen startup and rejected Play; handle replacement HLS errors even if the original Play promise never settles.
- Preserve selected version/tracks, native resume and independent SRT/ASS subtitle rendering through fallback.
- Add the complete review in DIRECT_PLAY_REVIEW.md, unit coverage and browser startup/fallback regressions. Physical LG decoding remains unverified.

## 1.11.4

- Fix episode refresh identity/focus, aggregate watch badges and cache state, rapid/paused track changes, Plex XML success responses, subtitle offset isolation, and delayed episode launch races.

## 1.11.3

- Correct subtitle timing, asynchronous sync changes, and measured clearance above controls.

## 1.11.2

- Fix automatic resume across every seek entry point and slow LG buffering; preserve explicit Pause intent.
- Add full 15–16 November regression review and decoder event-order coverage.

# webOS changelog

## 1.11.1 — Seek playback recovery and Reset alignment

- Keep the automatic-resume request active after confirming a seek until the decoder clock actually advances. LG can report an unpaused state without decoding further frames.
- Invoke Play within the confirming OK interaction when the decoder has paused, retry stalled Play promises, and recover a frozen-but-unpaused decoder with a bounded pause/play transition after buffering completes.
- Preserve deliberate Pause, Back dismissal, normal seek preview behavior, and focus when playback recovers.
- Redraw the subtitle-sync Reset arrow with centered SVG geometry and explicit centering so the control no longer sits off-axis on older webOS Chromium.
- Add regression coverage for frozen decoder clocks, unresolved Play promises, and Reset icon geometry.

## 1.11.0 — Local SRT/ASS subtitles and live sync

- Render external Plex SRT subtitles using Media Captions and ASS/SSA with SubtitlesOctopus/libass.
- Switching the selected subtitle file and changing the existing subtitle sync offset updates the active renderer; positive offset delays subtitles.
- Lift SRT captions when transport controls appear, preserving authored ASS sign positions.
- Keep v1.10.2's conservative Direct Play capability rules; an external SRT/ASS track does not by itself require transcoding video. Embedded and unsupported subtitles still use Plex HLS burn-in.
- Include libass workers and Chromium 53 compatibility in the TV package.


## 1.10.2 — Restore reliable Plex playback

- Revert the expanded HEVC/MKV native Direct Play selection from v1.10.0 after intermittent playback failures on LG webOS.
- Restore the conservative MP4/M4V/MOV H.264 Direct Play gate and use Plex HLS for other codecs/containers.
- Keep the unrelated v1.10.1 seek-resume and subtitle-sync controls fixes.

## 1.10.1 — Reliable seek resume and TV subtitle sync focus

- Match Plezy's preview behavior: remote seek movements update BIF/timeline only, without pausing the decoder or initiating a seek until OK.
- After OK, preserve the pre-seek play/pause state. Recover automatically from delayed or missing `seeked` events on older LG decoders, without reopening hidden controls.
- Subtitle sync Up/Down adjusts the offset by 50 ms while Left/Right moves focus one control at a time, including directly across the slider without adjusting it.
- Replace all Unicode sync-bar button glyphs with reliable SVG icons, including Reset, which previously appeared as a missing-glyph box on some LG TVs.
- Extend browser regressions for delayed resume, decoder deadlock recovery, cancel/Back, complete D-pad traversal, and SVG visual states.

## 1.10.0 — Direct Play compatible Plex formats

- Use the LG webOS 4.x codec/container capabilities instead of transcoding every MKV or HEVC file.
- Direct Play supported H.264/HEVC MP4 and MKV sources, with compatible AAC/AC3/EAC3 audio and supported HD DTS/PCM audio.
- Keep HLS for incompatible codecs, selected subtitles, different/non-default audio tracks, server-default subtitles, and manual Compatible playback, with automatic fallback if the LG decoder rejects a direct stream.
- Preserve native `mediaOption` resume and correct source MIME; add codec/profile/bitrate tests and browser fallback coverage.

## 1.9.3 — Match Plezy episode-row metadata

- Use Plezy's normal-weight muted metadata text rather than relying on inherited button typography.
- Give each episode metadata separator its own spaced bullet, matching Plezy's 6 logical pixels on either side at TV scale.
- Restore the 6px vertical gap above metadata without the extra inline-text line box.
- Add a real-browser layout check for episode-row metadata weight, separation, and vertical spacing.

## 1.9.2 — Plezy subtitle-sync focus and layout

- Replace the incorrectly embedded subtitle slider with Plezy's compact top-centered sync bar, opened from a settings row.
- Focus the slider immediately on LG remote activation. Arrow left/right adjust by 50 ms; Up/Down leave the slider for the −/+ buttons without changing its value; OK focuses Close. All buttons use reachable spatial focus, and Back returns to the player.
- Match Plezy's ±10 s fine-control slider, ±60 s maximum via step buttons, and 1 s long-press acceleration.
- Use Plezy's signed millisecond/second offset labels and white slider-thumb focus treatment.
- Add browser tests for remote-key focus, visual geometry, long-press adjustment, minute limits, and cue resets.

## 1.9.1 — Fix remote seek preview and Back dismissal

- Left/Right now move only the timeline/BIF preview; the webOS decoder seeks and buffers only when OK commits the target.
- Moving focus away or pressing Back cancels an unconfirmed seek instead of implicitly seeking. Resume the original playback state, including staying paused if already paused.
- Prevent delayed decoder events and spurious focus/mouse events from reopening controls after Back; the next Back exits playback.
- Cover repeat seek steps, confirmation, cancellation, late playback events, and paused playback in browser regressions.

## 1.9.0 — Subtitle synchronization

- Add a subtitle timing adjustment control to playback settings, covering offsets from −60 to +60 seconds in 50 ms increments.
- Show the current offset, support reset, and retain each media item's chosen offset between playback sessions.
- Apply the offset to native WebVTT/TextTrack cues without accumulating repeated adjustments.
- Add browser regression coverage for both offset extremes and reset behavior.

## 1.8.9 — Keep episode details mounted after watched changes

- Marking an episode watched or unwatched now updates the existing action buttons and play/resume state in place, without clearing or rebuilding the detail page, flashing its artwork black, or losing focus.
- Apply the same behavior through the episode More options menu, retire stale in-flight detail revalidations, and update the saved detail snapshot after a successful mark.
- Add real-browser regressions for watch/unwatch and menu actions, checking that the original detail DOM remains attached and remote focus survives.

## 1.8.8 — Stable skip prompt and Plezy timeline focus

- Stop resetting the skip prompt's measured bottom offset on each playback update. Its position now remains stable while the same chrome state is visible, including repeated marker and playback events.
- Enlarge Plex BIF seek-preview frames from 160px to 320px, clamping the tooltip to narrow timeline widths.
- Follow Plezy's focused timeline design: replace the rectangular focus border with an 18px shadowed white knob, retaining a slim handle when unfocused.
- Add browser regressions for stable skip placement, large preview frames and focus styling.

## 1.8.7 — Restore player focus and seek previews

- Keep the last focused transport button selected through intro-skip buffering and decoder focus loss; stop the inactivity timer from hiding actively focused controls.
- Leave Left/Right to normal transport focus navigation, including after a timeline seek. Only the timeline or hidden video surface may initiate directional seeking.
- Place the Skip Intro/Credits prompt above the measured controls height, clear of the seekbar on different TV layouts.
- Keep a visible skip prompt at its current anchor during pointer interaction so revealing controls cannot move it away before the click is registered.
- Port Plezy's Plex BIF scrub-frame reader and timeline preview tooltip, with time labels, a 50 MiB TV download limit, cancellation and frame cleanup when changing videos.
- Regress focus restoration, navigation, skip placement, BIF parsing and rendered preview, without changing chapter or skip matching.

## 1.8.6 — Programme chapter key navigation

- Map Programme Up/Down (legacy LG Page Up/Down events) to Plezy's next/previous chapter navigation, with elapsed-time rewind handling and no wrapping.
- Preserve chapter sheet and track-menu focus while using chapter keys. Physical LG key delivery remains device-dependent.

## 1.8.5 — Recognize and combine logo/intro chapters

- Include `logo` and `logos` in the default intro-chapter regex, including labels such as "Studio Logos". This is a user-requested extension of upstream Plezy's default.
- Coalesce immediately consecutive chapter-derived intro segments (such as Logos then Opening) so a single skip action passes both, without merging across scenes or exceeding the three-minute safeguard.
- Preserve word boundaries, native marker precedence, the three-minute synthesized-intro limit, and custom intro patterns.
- Cover Plex, Jellyfin and browser playback, including a single click across adjacent intro chapters.

## 1.8.4 — Let Home carousels extend through page gutters

- Extend Home and recommended carousel scrollports to the actual main-pane edges, so moving cards remain visible through the page's horizontal padding instead of being clipped at the header inset.
- Preserve the initial card/title alignment and final end padding, including the compact-screen 32px layout. Add a real-browser test for visible cards in both side gutters.

## 1.8.3 — Skip-prompt focus and seek cleanup

- Replace the Skip Intro/Credits button's square-looking external focus outline with Plezy's filled, slightly scaled rounded focus state.
- Keep a manually or automatically skipped marker dismissed while the video decoder still reports the old position during seeking and buffering; re-enable its prompt on an explicit user seek back into the marker.
- Regress focus appearance and delayed media seek completion, including a subsequent manual rewind.

## 1.8.2 — Repair missing Plex intro prompts and chapter gaps

- Fetch chapter and intro/credits marker metadata at playback startup, as native `PlexClient.getPlaybackExtras` does. Cached Home and episode rows can omit the markers even when Plex has them; refresh the playing session without delaying video startup.
- Read Plex's `Chapter.tag` for chapter titles, including the chapter-name fallback used to identify intros.
- Fix a CSS selector that accidentally assigned each chapter separator the timestamp's 52px minimum width. Seek-bar gaps now measure Plezy's intended 4px.
- Permit LG's `playing` event to confirm the first frame when its reported media `readyState` is stale, so the floating prompt can appear and gain remote focus.
- Regress thin metadata, late playback extras, focus and single-press skip, measured chapter-gap width, and stale decoder state.

## 1.8.1 — Keep Right navigation within each carousel

- Match Plezy's locked-focus hub rows: Right moves to the next card in the same carousel, but does nothing at its final card instead of moving into another carousel.
- Preserve independent horizontal scrolling, Left-to-sidebar navigation and vertical movement between Home rows. Add a multi-carousel browser regression.

## 1.8.0 — Chapter controls and one-press intro skipping

- Follow Plezy's chapter sheet: mark and initially focus the chapter currently playing, show title and timestamp on separate lines, and display chapter thumbnails supplied by Plex.
- Show chapter boundaries on the timeline and provide previous/next chapter transport actions, including Plezy's three-second previous-chapter restart rule and remote media-skip key behavior.
- Automatically focus the floating Skip Intro/Skip Credits button when a marker appears during playback on webOS, including when the first frame precedes the decoder's `playing` event. OK skips immediately; an open chapter/track sheet retains its focus.
- Keep existing Plex and Jellyfin marker precedence, chapter-title fallback, auto-skip countdown, and dismissal semantics. Add model and browser regressions.

## 1.7.1 — Icon-only episode menus and persistent track sheets

- Show only the three-dot SVG on season episode overflow buttons, retaining the per-episode accessible name without rendering “More options” behind the row.
- Keep episode audio/subtitle selection open after choosing either track; update the selected ticks in place so both can be chosen before closing.
- Keep the player's TrackSheet visible through source switching and codec fallback/restarts, with the chosen track focused and the latest selection marked. Close still works through Back or the sheet's Close button.

## 1.7.0 — Carry audio and subtitle choices across a series

- Carry explicit language/track choices from the player and episode menus to other episodes of the same show, including across seasons. Resolve against each episode's source stream IDs instead of reusing IDs from another file.
- Preserve distinct commentary audio, forced subtitle tracks, and subtitle Off. Decline ambiguous or unavailable matches and allow Plex's per-episode selection to take over, as Plezy does.
- Fetch missing episode stream catalogs before playback so both the player menu and cross-episode carry work when a season row has only lightweight metadata.
- Isolate choices by series and server account; latest series choice supersedes older sibling choices. Add unit and browser regression coverage.

## 1.6.0 — Episode menus and combined audio/subtitle selection

- Open a combined audio/subtitle track picker from the player, with labeled source streams, Off for subtitles and current-selection indicators, following Plezy's TrackSheet.
- Add episode-specific More options to episode details and season-list rows; watched/unwatched actions respect partially watched state.
- Allow choosing source audio/subtitle tracks per episode before playback, fetching complete stream metadata when season lists omit it. Pass selections to Plex/Jellyfin playback instead of changing all episodes.
- Preserve remote focus through menus, track selection and Back; add source-ID and browser regression coverage.

## 1.5.11 — Larger alphabet index characters

- Enlarge the library alphabet rail letters from 10px to 14px on normal TV viewports, with 22px circular markers and a 24px-wide rail.
- Keep the full A-Z index visible on shorter displays, scaling the letters and markers down when needed and updating their sizes on resize.
- Preserve the rail's right-side overscan, card focus clearance and keyboard navigation; add browser regression coverage.

## 1.5.10 — Focus Play on season details

- Default remote focus to Play when opening a season, as already done for episode details.
- Preserve the series link and its normal directional navigation.
- Add a browser regression for entering a season from its parent show.

## 1.5.9 — Restore horizontal shelf position on Back

- Preserve the individual Home and recommended shelf scroll positions when opening and returning from a detail page, along with the existing poster focus and vertical position.
- Restore offsets for retained DOM snapshots and after refreshed shelves are rebuilt. Match shelves by heading to avoid mixing up reordered rows.
- Add a browser regression for returning from an offscreen carousel item.

## 1.5.8 — Fix false buffering spinner

- Only show the playback-buffering indicator when the decoder actually needs additional data to advance, not merely because the network reports a stall.
- Clear stale buffering on pause and at EOF, including while credits are playing; preserve startup buffering and paused seek-frame previews.
- Cover buffered playback, pause, EOF and paused seeking with unit and browser regression tests.

## 1.5.7 — Keep fast library scrolling populated

Load the visible sparse range directly in either direction, display scrolling cards independently of artwork decoding, and start adjacent metadata prefetch at least three rows ahead. Preserve the current scroll position when delayed requests complete.

## 1.5.6 — Preload artwork while scrolling libraries

- Prefetch artwork three card rows above and below the visible library viewport, including both regular and sparse alphabetical grids and episode lists.
- Use measured CSS card row height and spacing, including Chromium 53 flex fallback, so the buffer follows TV layout rather than a fixed margin.
- Load visible artwork before nearby off-screen rows, favoring the scrolling direction without increasing the existing six-download limit.
- Keep distant artwork deferred; add unit and browser regressions for scroll-buffer behavior.

## 1.5.4 — Plezy On Deck episode captions

- Identify Plex Continue Watching hubs as On Deck, including global hub results and fallback shelf results.
- Display episode cards as in Plezy: the series name above “S# E# · Episode title”, including season zero.
- Retain original episode titles for playback and detail pages and leave movie cards unchanged.
- Add unit, Plex API and browser regression coverage.


## 1.5.5 — Faster parallel artwork loading

- Raise cold-artwork concurrency from two to six, matching Plezy's native full-performance image request limit.
- Prioritize currently visible posters over nearby prefetch images; preserve existing cache-hit, disk prewarm and offscreen deferral behavior.
- Keep a bounded queue and regression coverage for request limits and cached image loading while downloads are stalled.

## 1.5.4 — Plezy On Deck episode captions

- Identify Plex Continue Watching hubs as On Deck, including global hub results and fallback shelf results.
- Display episode cards as in Plezy: the series name above “S# E# · Episode title”, including season zero.
- Retain original episode titles for playback and detail pages and leave movie cards unchanged.
- Add unit, Plex API and browser regression coverage.


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
