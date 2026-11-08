# Contributing

Small, focused issues and pull requests are welcome. Discuss changes to buttons, categories, or watch support before implementing them. Keep the watch interface minimal and usable without touch.

## AI-assisted contributions

Agents are welcome to write issues, investigate bugs, implement changes, and draft documentation. Apply the same review standards to all contributions. The person submitting remains responsible for correctness, licensing, privacy, and the claims made.

Every issue and pull request must include an **AI usage** statement. Report separately:

- **Writing**: the agents/tools and model(s) used to write or translate the issue, PR description, or documentation, and their role.
- **Implementation**: the agents/tools and model(s) used for investigation, code, assets, tests, or review, and their role. For an issue with no implementation, say “Not applicable”.

Examples:

```text
Writing: Codex through T3 Code, gpt-6.1-sol. Drafted the PR text; I edited it.
Implementation: Codex through T3 Code, gpt-6.1-sol. Implemented and tested the fix.
```

```text
Writing: None.
Implementation: GitHub Copilot, model not exposed by the tool. Suggested part of the parser.
```

“None”, “Not applicable”, and “Unknown / not exposed” are valid and useful. Include every model actually used when known. Do not guess a model name, claim checks you did not run, or paste private prompts, tokens, conversations, server addresses, or machine paths. No raw agent transcript is required.

The initial public version was prepared with Codex through T3 Code, using gpt-6.1-sol for writing and implementation. The maintainer set the product direction and authorized publication.

## Pull requests

1. Keep one behavior change per PR where practical. Explain the trigger and resulting behavior.
2. Run `npm ci` and `npm run check`. A watch change also needs `npm run release` and an emery emulator check.
3. Add tests for changed behavior and meaningful failure cases. Avoid tests that simply repeat the implementation.
4. Include synthetic screenshots for layout changes and state which hardware/phone combinations were actually checked.
5. Update translations together or leave an untranslated key absent so English fallback applies. See [TRANSLATING.md](TRANSLATING.md).
6. Fill the PR template, including AI usage. Maintainers review before merging; green CI is not automatic approval.

Contributions use the project's MIT license. Do not add credentials, personal fixtures, build directories, PBWs, or source maps to Git. Release binaries belong in GitHub Releases.

## Issues

Search existing issues first. Use the matching bug, feature, translation, or iPhone compatibility form. Include app, watch, phone OS, Pebble app, and T3 versions where relevant. Redact personal data from logs and screenshots. Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Review

Check stale responses, network failure, changing snapshots, UTF-8 byte limits, and read-only permissions when relevant. Preserve the app UUID and existing message-key order. Additional message keys must be appended. Keep the phone companion ES5-compatible and new libraries proportionate to the watch's memory limits.
