# Agent instructions

This repository is a fork of **Plezy**. For any task involving the `webos/` port, first read [webos/PORTING.md](webos/PORTING.md).

**Upstream Plezy is the specification, not inspiration.** Read the corresponding original Flutter widget, controller, models, service and test(s) before implementing changes. Reproduce its UI, data, behavior, navigation, error handling and request payloads. Do not create an alternative screen, matching heuristic or API flow when Plezy already implements one.

Any unavoidable adaptation for **LG webOS 4.4.3 / Chromium 53** must be minimal, documented and backed by tests. Never claim full fidelity on the basis of an approximate HTML reimplementation. Do not replace a working native design with a new design.

Group related changes into clear, descriptive commits. Follow attribution or labeling instructions supplied by the agent's own task or operator; no repository-wide commit label is required. Verify the latest CI results and distinguish mock-test success from actual LG TV verification.

## Project publication authorization

The user has explicitly granted standing permission to push project fixes and publish releases after CI passes. Do not ask for confirmation for these routine actions. Use the GitHub API for releases, never browser automation.

## webOS PR validation and merge efficiency

For webOS PRs, inspect the latest PR head SHA and its GitHub check summary.
The final **test-and-package** gate must pass for that SHA; it requires unit
tests, Chromium 53 bundle/IPK checks, and all relevant E2E shards. Do not merge
when required checks are pending, missing, cancelled, or failed, or rely on a
previous successful SHA. Keep mock CI results distinct from LG TV validation.

WebOS PRs run the workflow once on pull_request instead of on every branch push.
The test selector limits browser tests only for proven isolated changes, always
adds the app smoke suite when targeting tests, and falls back to full E2E for
shared or unknown changes. Unit tests and packaging still run on every PR.
Master runs full E2E; only a successful master validation may publish an IPK.

Use GitHub auto-merge only when branch protection/rules enforce required CI
checks; otherwise merge via API after the final gate passes. Avoid 10-second
polling loops, repeated job-list retrieval, irrelevant master-run checks and
checking obsolete SHA runs. Inspect failures immediately, then monitor the
latest consolidated check at reasonable intervals. Do not rebase or force-push
solely to retrigger CI. Master CI separately guards post-merge publication.
