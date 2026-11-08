# Todo and proposals

These are candidates, not promised release dates. Use GitHub issues to discuss priorities and take ownership. Mark a task complete only with the relevant evidence.

## Compatibility and release follow-up

- [ ] Collect iPhone success and failure reports using the dedicated issue form, including pairing, persistence, VPN reachability, and dictation.
- [ ] Validate dictation with real Android speech services and record the app/service versions.
- [ ] Complete physical Time 2 validation of language changes, sending, and Bluetooth reconnection. The store-served 1.0 package has been installed and its saved connection loaded the thread list.
- [ ] Test token expiry, phone restart, VPN changes, and server upgrades on physical hardware.
- [ ] Add other Pebble models only after checking layout, available RAM, Bluetooth payload limits, and microphone support. Keep emery as the current packaged target.

## Languages and access

- [ ] Invite native-speaker reviews of English and French and contributions for additional languages.
- [ ] Evaluate fonts and right-to-left layout for scripts outside the current Latin font coverage.
- [ ] Explore a larger-text reader option and button-hint readability.
- [ ] Confirm configuration-page compatibility across Pebble mobile WebViews, especially offline settings and cryptographic randomness on iOS.

## T3 integration

- [ ] Synchronize desktop/watch unread state if T3 exposes a supported read-state API. Current state is local to the watch companion.
- [ ] Add explicit API capability/version diagnostics as the upstream contract stabilizes.
- [ ] Consider delta metadata refresh and limited concurrent environment reads for large installations, after measuring battery and network use.
- [ ] Improve diagnostics for an unreachable linked machine without exposing private conversation content.
- [ ] Consider per-server connection profiles only if real users need several independent T3 installations.
- [ ] Consider notification preferences, with quiet hours and no unsolicited thread content on the watch.

## Project maintenance

- [ ] Set up store release automation with restricted credentials/OIDC when supported and reviewed.
- [ ] Add a reproducible-build comparison across two clean environments, documenting SDK-generated timestamps.
- [ ] Consider a compact synthetic fixture mode for translation screenshots in additional languages.
- [ ] Review whether issues alone cover project planning before adding more workflow tooling.
