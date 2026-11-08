# Release checklist

- [x] Public source and license checked.
- [x] No personal server defaults, paths, credentials, or historical private refs published.
- [x] English/French settings and watch screens checked in the emulator.
- [x] Language change preserves pairing.
- [x] CI check and release build pass.
- [x] PBW has no source maps or absolute home-directory paths.
- [x] Synthetic screenshots, icons, description, privacy policy, and tutorial inspected.
- [x] GitHub release PBW and SHA256SUMS published.
- [x] Public Appstore listing and runtime package verified.
- [x] Store-served PBW installed on physical Time 2.
- [ ] Physical dictation checked. Pending compatibility work belongs in TODO.md.
- [x] iPhone reports invited without claiming untested support.

The 1.0.0 store-served PBW matched the GitHub release byte for byte and was installed on a physical Time 2 using Android. The saved connection loaded its linked-thread metadata successfully. Sending and real dictation in this release remain unverified on hardware.

1.0.1: pairing-link parsing and native form validation checked in a browser, followed by OAuth pairing and thread reading with the Time 2 emulator and synthetic server. All 55 tests and GitHub checks passed. The store-served PBW matched GitHub byte for byte and loaded the saved connection on a physical Time 2 with Android. Pasting a fresh link on the physical phone has not yet been checked.

1.1.0: 69 tests and GitHub checks pass. The Time 2 emulator covered paged machine/project selection, simulated dictation, review, cancel, French, read-only menus, preserved saved replies, and a lost launch reply followed by retry. Exactly one thread was created and opened automatically on retry. Real voice transcription and a live project launch remain to be checked on physical hardware.

The 1.1.0 store package matches the GitHub release byte for byte and was installed on a physical Time 2 using Android. The existing connection loaded its linked threads. The store dashboard exposes 1.1.0 as published; the public listing may still serve cached 1.0.1 copy during propagation.
