# Development

The watch is a native C app. `thread-list.c` contains a host-testable bounded list model. The ES5 phone companion connects directly to T3 through OAuth PKCE and MCP. `config/index.html` is bundled into a data URL; it receives connection metadata but never the existing bearer token.

`locales/*.json` generate the C string table, companion catalog, and embedded settings translations. `wscript` regenerates these before every Pebble build, including builds initiated outside npm.

## Check and build

```sh
npm ci
npm run check
pebble sdk install 4.44
npm run release
```

Pebble Tool 5.1.2 also requires `uv` on PATH to create its SDK Python environment. Install it with `python3 -m pip install uv` if needed.

The checks parse the companion as ES5 and run Node behavior tests plus C list tests under AddressSanitizer and UndefinedBehaviorSanitizer. Release packaging strips source maps and rejects absolute home-directory paths in runtime files. Original build artifacts remain local for debugging.

## Isolated emulator

```sh
node test/fixture-server.js
pebble install --emulator emery build/t3-pebble-v1.0.1.pbw
python3 scripts/emulator-config.py artifacts/fixture-config.json
pebble screenshot --emulator emery --no-open artifacts/example.png
```

Keep the fixture server running in a separate terminal. The Python helper needs the websocket-client package from Pebble Tool's Python environment. A headless emulator also needs a persistent X display, such as Xvfb. All fixture conversations and credentials are synthetic. Never configure the emulator against a private account for screenshots intended for publication.

To switch only the emulator language, pass a JSON file containing `{"preferences":true,"language":"fr"}` to the same helper. Check the original connection still opens without pairing again.

`scripts/live-check.js` is optional and requires explicit `T3_BINARY` and `T3_URL`. It creates temporary read-only authorization, exercises the real API, and revokes the authorization afterward. Do not run it against someone else's server or in CI.

## Protocol constraints

Preserve the UUID and append AppMessage keys. Correlate requests so late responses cannot replace the current view. A full phone metadata snapshot gets a revision; continuation pages must match it. Apply list refreshes after a pause and preserve selection by route.

Confirm actual display before marking a completed response read. Never let a delayed receipt undo explicit mark-unread. Preserve pending reply IDs across restarts to avoid duplicate sends. T3 controls final permissions and agent behavior.
