# Provider-Agnostic Image Generation Fidelity Contract

**Status:** Normative cross-launcher contract  
**Goal:** The user's configured image-generation conditions must be applied by the selected provider, and the resulting image must appear in the correct game portrait slot.  
**Android baseline:** `wal-studio/WAL-Android-Development`, `work/imagegen-provider-parity`, `f35ab58971da781236e19a842207db8f37ff3888`  
**Implementation branch:** `work/imagegen-request-fidelity-20261126`

## 1. Single success criterion

NAI, PC ComfyUI, and future providers are implementation choices, not separate product goals.

Success means:
1. Every user-selected generation condition reaches the selected provider without launcher-side content filtering or mutation.
2. The provider actually applies the supported conditions; unsupported conditions are reported explicitly and never silently replaced.
3. The original game receives the provider result using the response contract it expects.
4. The original game save/output path and character-to-portrait mapping remain intact.
5. The final portrait is visible in the intended character slot and remains available after reload/restart.

The stochastic image pixels need not match between separate generations. The request semantics, effective settings, result delivery, and portrait placement must match the user's intent.

## 2. Launcher intervention invariant

The launcher must not:
- censor, moderate, keyword-filter, suppress, or silently reject prompt content;
- rewrite positive/negative prompts, character tags, reference-image instructions, or unknown fields;
- replace workflow, model, checkpoint, LoRA, sampler, scheduler, seed, dimensions, steps, CFG, strength, or provider-specific options;
- inject defaults over explicit user values;
- discard an option because the launcher does not understand it;
- post-process, recompress, crop, upscale, regenerate, substitute, or silently discard a provider result;
- report success when the provider rejected or failed to apply a requested condition.

For a transparent relay, preserve the original HTTP method, path/query, content type, all non-hop-by-hop headers, and request/response body bytes. Do not parse and reserialize generation payloads merely to inspect them.

Transport safety is separate from content policy. Pairing authentication, TLS validation, path authorization, bounded resource use, and secret isolation remain mandatory. Such controls must not rewrite image-generation conditions. Provider credentials stay with their owning launcher and are never exposed to game JavaScript, logs, or the other device.

## 3. Ownership and provider routing

- Android NAI mode: Android Launcher owns the NAI token, NAI settings, and the existing mobile NAI execution engine.
- PC ComfyUI mode: PC Launcher/Host owns the ComfyUI endpoint, model paths, workflow runtime, and PC-side credentials.
- The game owns its original image request, character identity, portrait slot, and native save/display behavior.
- A routing layer may select the configured provider and transport, but may not edit generation content.

For a PC-executed game using mobile NAI, the intended path is:

`PC game → PC Host authenticated game-image entry → paired mobile NAI job delivery → existing Android NAI engine → exact result bytes → PC Host workspace → original game response/save → portrait`

The PC Host must correlate each job with the paired device, game workspace, and request ID. The mobile device must not expose its NAI token to the PC.

## 4. Result storage

The game’s native image save/display contract has priority. Where the game expects a generated-image anchor, the PC Host must persist the returned bytes under the selected approved game root and return the exact URL/metadata expected by the game. The existing `images/__wayward_generated__/` anchor convention may be reused where the original game contract requires it.

Do not create a second global image library or silently save PC-game results only in Android app-private storage. Use the session's approved `hostId + rootId + relativePath` context. Writes must be atomic and integrity-checked; failed writes must not be reported as completed generation.

## 5. Current Android implementation finding

At baseline `f35ab58971da781236e19a842207db8f37ff3888`, `ImageGenProxy.dispatch()` rewrote every local `POST /api/image/generate` body by replacing `workflow` with `illustrious`. This contradicted the fidelity invariant even though the other request fields were retained.

The mobile implementation branch removes only that generation-body rewrite. The original request body now reaches the selected local backend unchanged. Launcher-selected provider configuration remains a separate control-plane concern; credential storage and provider ownership are not moved into the game.

The legacy Android Remote PC API path still targets the PC Host's Comfy-only game-image API. It is not the transport for PC-game-to-mobile-NAI execution.

The separate `PUT /api/generation/settings` control-plane path still removes credential/endpoint fields and pins `imageProvider` to the launcher-selected provider. This patch does not claim that settings-control path is byte-transparent. Those fields represent launcher-owned provider selection and secret boundaries; before claiming the full zero-intervention contract, the settings model must separate launcher-owned provider/auth metadata from every user-controlled generation condition and prove that no non-secret generation option is silently dropped or normalized.

## 6. Required PC Host integration before PC-game NAI is complete

The current PC Host source has a ComfyUI-only `LocalGameImageApiBridge`; `/api/nai/check` explicitly returns `unsupported_provider`, and the Host's `ImageGenGateway` proxies to the PC-local `127.0.0.1:8189` service. The current pairing direction authenticates Android requests to the PC Host; it does not yet deliver PC game generation jobs to the Android NAI engine.

Therefore, PC-game-to-mobile-NAI is **not complete** until the PC Host adds an authenticated, paired-device job channel and result-return path. A mobile-only patch cannot truthfully claim that reverse transport exists.

Preferred minimal transport direction:
- PC Host queues the original game request and holds the game-facing request open against a correlated job.
- Android initiates the authenticated connection and retrieves the next job (long-poll/SSE or an equivalent existing channel); no unsolicited public inbound phone port is required.
- Android invokes the existing NAI engine with the original request and mobile-owned NAI configuration.
- Android returns the provider response/result bytes and status against the same job ID.
- PC Host persists the image into the selected approved workspace and completes the original game-facing response.
- Pairing revocation, permission denial, cancellation, timeout, retry, and concurrent sessions are explicit states.

Do not implement a second NAI engine or alter the existing PC ComfyUI path.

## 7. Acceptance tests

- Byte-for-byte generation request body preservation through each relay boundary.
- Exact preservation of unknown nested fields, binary/multipart content, and provider-specific options.
- Effective provider settings compared with the user's selected settings; unsupported fields fail visibly rather than being silently replaced.
- No prompt or credential leakage in diagnostics/logs.
- NAI and ComfyUI success, provider rejection, cancellation, timeout, retry, and concurrent-job correlation.
- Exact output bytes and metadata reach the original game contract.
- Image is stored under the correct approved PC game root and associated with the requested character/portrait slot.
- Reload/restart retains the correct portrait.
- Existing local NAI, PC ComfyUI, CloudSave, SAF, pairing, and file access regressions remain covered.

A test that only asserts HTTP 200 or a non-null image is insufficient. Record the request, effective settings, provider result, saved path/hash, and final portrait association as separate evidence.
