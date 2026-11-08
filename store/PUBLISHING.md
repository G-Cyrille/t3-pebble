# Publishing

Keep the UUID unchanged for updates. Use the maintainer's Pebble developer account. Treat `pebble publish` as immediately public; it is not a dry run.

1. Update package version, changelog, store notes and metadata.
2. Run `npm ci`, `npm run check`, and `npm run release` on a clean source checkout. Check the emulator in English and French, preserving the connection across a language change.
3. Inspect synthetic screenshots, icons, listing copy, docs and privacy policy. Release PBWs must have no SDK source maps or local paths.
4. Push source to GitHub and wait for Check and build. Tag `vX.Y.Z`; the release workflow checks, builds and uploads the PBW plus SHA256SUMS.
5. Download the GitHub release PBW and verify its checksum. Publish **that file** with `pebble publish --pbw ...`, which avoids rebuilding on the publishing machine. Keep `--screenshots` last because it consumes the remaining arguments.

```sh
pebble publish --non-interactive --no-gif-all-platforms \
  --pbw build/t3-pebble-v1.0.1.pbw --is-published \
  --name 'T3 for Pebble' --version '1.0.1' \
  --description "$(cat store/description.txt)" \
  --release-notes "$(cat store/release-notes.md)" \
  --source https://github.com/G-Cyrille/t3-pebble --category tools \
  --icon-small store/assets/icon-80.png --icon-large store/assets/icon-144.png \
  --screenshots store/screenshots/emery_threads.png store/screenshots/emery_replies.png
```

For an existing app, omit screenshots unless adding new ones. Do not use replace-screenshots casually. The CLI may not expose all listing fields; verify developer, version, platforms, source, screenshots, privacy URL and tutorial URL in the dashboard/API after publication. `store/metadata.json` records the public references.

Download the Appstore PBW and compare runtime ZIP entries with the GitHub release. The store may normalize UUID casing, so compare entries if archive checksums differ. Install that store-served PBW on physical hardware and verify opening, settings, reading and reconnecting. Record untested features honestly in the checklist.
