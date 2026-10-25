# Agent instructions

This repository is a fork of **Plezy**. For any task involving the `webos/` port, first read [webos/PORTING.md](webos/PORTING.md).

**Upstream Plezy is the specification, not inspiration.** Read the corresponding original Flutter widget, controller, models, service and test(s) before implementing changes. Reproduce its UI, data, behavior, navigation, error handling and request payloads. Do not create an alternative screen, matching heuristic or API flow when Plezy already implements one.

Any unavoidable adaptation for **LG webOS 4.4.3 / Chromium 53** must be minimal, documented and backed by tests. Never claim full fidelity on the basis of an approximate HTML reimplementation. Do not replace a working native design with a new design.

Group related commits and include **[ChatGPT Chat]** in the commit subject. Verify the latest CI results and distinguish mock-test success from actual LG TV verification.
