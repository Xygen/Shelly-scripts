# Repository contribution and language rules

## English-only policy (effective October 20, 2026)

**All new and updated repository documentation and all script-generated human-readable output must be written in English.**

This applies to:
- README files, setup instructions, technical documentation, changelogs, release notes, issues, pull request descriptions, and commit messages.
- Source-code comments, inline explanations, docstrings, and headings.
- Runtime output shown to users, including `console.log` messages, debug output, warnings, errors, and status messages.
- Human-readable test descriptions, diagnostic labels, and example output.

Guidance for changes:
1. Write all new documentation and human-readable strings in English, regardless of the language used to discuss the task.
2. When changing existing code, translate any affected German comments or output strings to English.
3. Existing historical files or untouched legacy text are preserved until explicitly updated; do not rewrite functional code solely to translate it unless requested.
4. Keep identifiers, MQTT topic names, configuration keys, and other machine-readable interfaces stable. Translate them only as part of a separately reviewed compatibility change.
5. Before merging, check the changed lines for unintended non-English comments, documentation, and user-visible messages.

This policy applies to all future work on this repository, including automated or AI-assisted contributions. It does **not** require the owner's conversations with contributors to be in English.

## Reusable motion-control script requirement (effective October 21, 2026)

The `blu-motion.js` implementation must be reusable across compatible Shelly devices with **one or more associated Shelly BLU Motion sensors**. Maintain a **single configurable implementation**, not separate one-sensor and three-sensor forks.

- Define the motion sensors exclusively through `CONFIG.sensors` (display name and Bluetooth MAC address).
- A single configured sensor must control `Switch 0` directly from its motion state; with two or more sensors, use OR logic (any active sensor keeps the relay on).
- Never hard-code three sensors into start-up logic, runtime messages, state handling, MQTT topics, or diagnostics.
- Ignore BLE packets from unconfigured addresses. Validate the configuration before starting; zero valid sensors must **not** result in unintended relay operations.
- Preserve the current relay semantics, per-sensor duplicate protection, MQTT illuminance topics, and expiry safeguards unless a change is explicitly reviewed.
- Provide deployment examples for both single-sensor and multi-sensor installations, always using placeholder MAC addresses in this public repository.
- Regression tests must exercise 1, 2, and 3+ sensors, duplicate/invalid/empty configurations, and unchanged relay behavior.
- Do not assume every Shelly model is compatible: require support for Scripts, BLE scanning, and the target relay RPC method. State hardware limitations accurately.
- Source comments, runtime log output, documentation and tests must follow the English-only policy above.

Existing on-device deployments are not modified by changes to this repository; device rollouts must be handled separately.
