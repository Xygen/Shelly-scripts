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
