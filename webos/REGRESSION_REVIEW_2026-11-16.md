# Regression review: 15–16 November 2026

Reviewed master from 6dcec85002c06ae721d8c74368f4bb89ff5671bc through 8aba9b9aa43d8519ffdd3be3ccebccca8d65a8f5 (63 commits). Review covers the combined diff and surrounding implementation; reverted Direct Play expansion is excluded from outstanding findings.

## Findings before changes

1. Only commitSeek arms automatic resume; pointer, chapter and skip seeks call seekTo without it.
2. Seek recovery expires after 15 seconds, requires a ±1-second target, and never requests Play for an unpaused decoder still reporting seeking. Slow buffering, HLS keyframe landing and frozen decoders can escape recovery.
3. Play/Pause keys do not consistently cancel/update unconfirmed preview intent; confirmation can override a viewer's explicit pause.
4. reopen snapshots new options only after awaiting cleanup. Rapid selections can merge from old options and restart at a reset video clock.
5. reopen always starts playing, including track changes made while paused.
6. Plex track PUT goes through JSON parsing although successful responses can be XML.
7. SubtitleOverlay.load retains its original offset argument over asynchronous download/parse and overwrites a newer adjustment.
8. SRT rendering follows only timeupdate (~4Hz); short cues can be missed. Clamping shifted subtitle time to zero shows a cue starting at zero before a positive delay expires.
9. SRT lift is a fixed 135px rather than measured controls clearance.
10. Subtitle sync storage keys contain only item ID, permitting collisions across servers/accounts.
11. The added episode-entry wrapper has no dataset.focus; incremental reconciliation cannot reuse unchanged episode rows. Overflow controls also have no stable focus key.
12. In-place season/show watched updates patch only the parent; visible child watched/progress badges stay stale.
13. Async play metadata loading has no launch generation; two requests on one route can complete in reverse order.

14. Pointer hover reused seekPreview for its tooltip, overwriting a pending D-pad confirmation target while leaving the slider readout unchanged.

## Validation limits

No local execution runtime or physical LG TV is available in this session. Branch GitHub Actions runs unit, Chromium bundle compatibility, browser tests and IPK packaging. Decoder event-order simulations are regression coverage, not a claim of LG hardware verification.
