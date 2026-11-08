# Translating

English is the source language. French is included. New language contributions and corrections from native speakers are welcome, including contributions drafted with an AI tool and reviewed by a speaker.

1. Copy `locales/en.json` to a BCP-47-style filename such as `de.json` or `pt-BR.json`.
2. Set `language` to the language's own name. Translate values inside `strings`; keep keys unchanged.
3. Preserve `%d`, `%s`, and any `{placeholder}` exactly, including order for printf values.
4. Keep button hints and tabs short. Saved prompts must fit in 900 UTF-8 bytes. Do not translate protocol identifiers or the special unread label **Done** without discussing its meaning.
5. Run `npm run check` and `npm run release`. Check the Time 2 emulator, including tabs, long titles, actions, settings, and a summary draft. Include screenshots and note any unsupported glyphs.
6. Open a PR using the template. Disclose the agents and models used for writing/translation separately from implementation. “None” is welcome.

A catalog may omit untranslated keys; the generator fills them from English. Unknown language settings also fall back to English. A new catalog automatically appears in settings and is compiled for the watch and companion. Generated files are ignored; do not edit them.

The default Pebble system fonts do not cover every writing system. Open a translation issue first if the language needs additional fonts, right-to-left layout, or more room. Those changes need hardware and memory validation.
