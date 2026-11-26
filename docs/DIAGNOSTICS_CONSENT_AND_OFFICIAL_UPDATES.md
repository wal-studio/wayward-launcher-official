# Diagnostics Consent and Official Stable Updates

## Diagnostics upload consent

- The home-screen **진단** button opens a consent dialog before creating or uploading a ZIP.
- **취소**, Back, or outside-dismiss performs no archive creation and no network request.
- **동의하고 전송** creates a new ZIP or reuses a failed-upload ZIP, then calls the existing `DiagnosticsBundleUploader` once.
- The dialog describes collected metadata, launcher/image-pack journals, bounded exception stacks, and redacted ImageGen log tails.
- Known Bearer credentials, API keys, tokens, passwords, cookies, absolute device paths, and content URIs are masked where the existing redaction pipeline recognizes them. Diagnostic messages can still contain environment context.
- Game HTML, save files, image files, and selected game-folder contents are not attached.
- The upload destination remains `https://wayward-diagnostics-ingest.trpgengine.workers.dev`; the existing ticket/upload protocol and Cloudflare Worker, D1, and private R2 schema are unchanged.
- The optional Android share chooser is still opened after consent; any additional recipient is selected manually by the user.
- A failed upload retains its ZIP for a later, separately consented retry.
- The legacy background `DiagnosticsUploader` path to the Vercel `/api/v1/ingest` endpoint is no longer invoked. Journals remain local until the user consents to the ZIP flow.

## Official update contract

- The updater reads only `wal-studio/WAL-Official-Releases`.
- A release is eligible only when `draft=false`, `prerelease=false`, its tag is strict stable `vMAJOR.MINOR.PATCH`, and the derived versionCode exceeds the installed version.
- Development/source-repository releases are not a fallback.
- The release must contain exactly one installable APK with the exact name `WAL-Android-Launcher-x.y.z.apk` and a matching `WAL-Android-Launcher-x.y.z.release.json` manifest.
- The manifest pins package name, version name, version code, official signer SHA-1, APK filename, byte length, and SHA-256. The GitHub asset digest, when supplied, must match the manifest.
- Metadata and the small manifest may be fetched during checking. APK bytes are not downloaded until the user selects **업데이트**.
- After that selection, the app checks HTTPS/HTTP status, redirect host, byte length, SHA-256, actual package ID, version name/code, and the registered signing certificate before invoking Android's normal package installer.
- Android's package installer remains responsible for final installation approval. The app never silently installs.
- **나중에** stores the dismissed versionCode. Automatic checks do not repeat that version; manual **업데이트 확인** remains available.
- Automatic network/API failures are logged and do not block launcher startup.

## Release packaging

Official version 1.0.1 uses versionCode 2 under the existing version formula. The official build script emits:
- `WAL-Android-Launcher-1.0.1.apk`
- `SHA256SUMS.txt`
- `WAL-Android-Launcher-1.0.1.release.json`
- The release workflow publishes only the official signed APK, checksum, and manifest as a stable release; Debug/Test APKs are never update assets.
- Re-running release verification never overwrites an existing stable release or its assets.
- The initial public release is 1.0.1; subsequent releases must use a higher versionCode and a published stable tag.
- The updater verifies the official package identity and signing certificate from the release manifest before installation.
- APK download and Android installation remain user-initiated after the update prompt; the app never auto-installs.
- The update dialog can be dismissed with Later and checked again manually from launcher settings.

No Worker, D1, R2, authentication, game profile, save-data, or launcher package identity changes are part of this feature.
