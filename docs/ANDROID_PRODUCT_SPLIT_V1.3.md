# WAL Android product split v1.3

This document records the product boundary for the isolated Android work branch. It does not replace the existing Android/Remote Play integration contract.

## Product identities

| Property | Development | Official |
|---|---|---|
| Build type | `debug`, `release` | `official` |
| Application ID | `com.wayward.launcher.official` | `com.wayward.launcher.official.wal` |
| Debug application ID | `com.wayward.launcher.official.debug` | Not published |
| Version | `1.0.9` / code `109` | Documented development build metadata; verify against the current Gradle configuration before a release. It is not a development baseline selector. |
| App label | WAL Development | WAL Android Launcher |
| Signing | Existing registered Release certificate | Same registered Release certificate |

The Official build is a separate Android package. Android therefore gives it an independent app sandbox, preferences, files, SAF grants, WebView state, and Android Keystore namespace. No Development data or device credentials are copied into Official.

## UI and behavior boundary

Official hides the PC folder picker, PC pairing entry, Remote PC file manager, ComfyUI/Remote Play image route, and PC discovery/registration hooks. The underlying PC and Remote Play implementation remains in source and in the Development product; it is not deleted or rewritten.

Official retains the device-folder picker, diagnostics, game-folder validation, game profiles/session handling, and local image-pack/local generation behavior. The stable updater engine and Official-only lifecycle/installer integration are present. Update checks run on Official home resume with a six-hour throttle; downloads are SHA-256 and signer checked, and installation is handed to Android's user-approved package installer.

## Stable updater contract

- Source of releases: public `wal-studio/WAL-Official-Releases`.
- Stable tags only: `vMAJOR.MINOR.PATCH`.
- Draft and prerelease entries are ignored.
- Exactly one APK asset is accepted: `WAL-Android-Launcher-MAJOR.MINOR.PATCH.apk`.
- SHA-256 is read from the GitHub asset digest or `SHA256SUMS.txt`.
- Before handing the APK to Android Package Installer, the updater verifies SHA-256, package ID, version/tag agreement, increasing versionCode, and the registered Release signer SHA-1.
- Android's package installer remains responsible for the user's explicit install approval.
- `versionName` is supplied with `-PwalOfficialVersionName=MAJOR.MINOR.PATCH`; `versionCode` is derived as `1 + (MAJOR - 1) * 1,000,000 + MINOR * 1,000 + PATCH` (`MAJOR >= 1`, `MINOR/PATCH < 1000`). The initial `1.0.0` build therefore remains code `1`, while `1.0.1` is code `2`.
- The Official app requests unknown-source install permission only when the user chooses to install an update.

## Android Remote Host reconnect integration

The product branch now includes the Android WAN reconnect implementation from the paired WAN work:
- The persistent host pairing record, temporary authenticated session, and host running/stopped state remain separate.
- LAN and WAN base URLs are stored separately; the authenticated host-connection refresh updates the WAN endpoint without replacing the LAN discovery address.
- Connection attempts prefer the last authenticated WAN endpoint, then LAN, then the original QR endpoint. Fallback is limited to connection/network failures; TLS and certificate-pin failures are not silently bypassed.
- mDNS discovery refreshes the LAN address only. It does not erase the WAN endpoint or the permanent pairing.
- Native crypto/keystore and source-contract regression tests are included. This validates the Android-side contract; it does not claim a live cross-network PC Host session.

## Validation status

- Historical implementation reference: `work/android-product-split-v1.3-20261120` / PR #1. This records the original product-split work only; it is not the current development baseline or an assertion of current PR state. Determine current work from the actual branch HEAD and current PR metadata.
- The Official and Development application identities, updater logic, and product-boundary source are the same as the signed-build source branch. The paired WAN reconnect classes and native instrumented test have also been copied into this branch; their file hashes match the validated paired-WAN source.
- Signed build: source branch commit `1413fcac8ef3c66d4fbe7b6bf07a5cc246b3e66c`, workflow run [44604007714](https://github.com/wal-studio/wayward-launcher-official/actions/runs/44604007714) completed successfully. The run embedded the pinned NovelAI backend, ran the full Android source contract suite and JVM unit tests, built Development Debug/Release and Official, and verified both distributable APKs use the existing Release signer SHA-1 `D9BE7443EB247D27C958CC4250D7F5D1E078F740`.
- Signed APK SHA-256: Development Release `7881103e165111418dc1c635c0994cf8d8dba45b76d266c49868596fa3112f8b`; Official `b9d66aa27b5901e60521a0e1aae1e56bc5a241a5c5dc3d76ae1023c0d64a171d`.
- The earlier Android-runner build failed with a real JVM crash: `Gradle build daemon disappeared unexpectedly`; the runner produced `hs_err_pid1040512.log`. The workflow now caps heap at 1.5 GiB, limits workers to two, disables parallel execution, and captures JVM crash diagnostics on failure. The rerun is in progress; no success is claimed until it finishes.
- Wireless ADB now tries the existing saved bridge and then already-paired `adb-tls-connect` mDNS services. The known saved bridge was unreachable in the previous run. No physical SM-S938N installation/startup result has been confirmed yet.
- The source validation workflow is also running Android 15 emulator/instrumentation checks. These are not a substitute for the physical SM-S938N test.
- `WAL-Official-Releases` currently has no stable releases. The updater's parsing, checksum, URL allowlist, SemVer, package and signer checks are tested, but real release discovery/download/Android installer handoff/relaunch has not been exercised against a published release.
- The official APK is signed and distributable by certificate identity, but no public release has been published.

## External OAuth registration

The native Google Identity authorization request uses the Drive `appdata` scope and does not supply a Web `serverClientId`; Android app identity is therefore bound to the package name and signing certificate. The existing Release SHA-1 is preserved, but the Official package has a new application ID. Google Cloud must have an Android OAuth client for `com.wayward.launcher.official.wal` with SHA-1 `D9BE7443EB247D27C958CC4250D7F5D1E078F740`. No Google Cloud OAuth registration has been changed or verified from this environment. Do not rotate the signing key. Official Google sign-in/CloudSave remains unverified until that existing-project registration is confirmed and exercised on device.
