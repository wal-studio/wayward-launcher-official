# PC ImageGen / Android Pairing — 2026-11-25 Forensic Handoff

## 목적과 범위

이 문서는 PC Remote Host의 이번 최소 수정 내역과 Android 런처의 후속 최소 수정 권장안을 함께 기록한다. Android 코드는 이번 작업에서 변경하지 않는다. 모바일 후속 구현의 기준은 공식 배포판이나 오래된 마이그레이션 브랜치가 아니라, 현재 저장소에서 확인한 가장 진보된 개발판인 **`work/official-dev-port`** 이다.

## 기준점과 대상 개발판

- 모바일 저장소: `wal-studio/wayward-launcher-official`
- 문서 기록 대상: `main` (default branch)
- 모바일 후속 수정 대상: `work/official-dev-port`
- 대상 개발판 HEAD 확인값: `3d94a35167f5d2ce2d1fb1bdf219d47a0f970f0f`
- 해당 개발판의 `app/build.gradle`: `versionCode 109`, `versionName 1.0.9`, Android SDK 35, Java 17
- 비교한 이전 이식 브랜치 `migration/dev-improvements-final-20261124-v2`는 `versionCode 106 / versionName 1.0.6`이며, 더 오래된 기반이다. 따라서 모바일 수정은 반드시 `work/official-dev-port`의 최신 내용을 기준으로 다시 확인하고 적용한다. 이 문서가 1.0.6 계열로 되돌리는 근거가 되어서는 안 된다.

## PC Remote Host 수정

저장소: `wal-studio/wayward-remote-host`

작업 브랜치: `fix/imagegen-readiness-pairing-diagnostics-20261125`

기준 브랜치/커밋: `work/restore-pc-deliverable-20261125` / `eb91f12b55d239847627cf9e49b58184b210dd7e`

변경 커밋:
- `197a2fadaa320248d910ef55a848580c61bafb6f` — ImageGen Provider readiness 상태 반영 (초기 커밋; 후속 보완 포함)
- `22b0cfb4e9b19b8c3f14a76605e4d37813fa5767` — Pairing 네트워크 차단 진단 로그
- `c370fd20bdcf29f490a59858e52aca40cc1813e7` — 기존 Provider 준비 대기 시간 5분 보존
- `8f11b338a7d3e8d85cbbc982e6c86e53528d7bf4` — PC 게임용 8189 직접 ComfyUI 브리지 구현
- `746cca4ec77805e147102df5d3affb2b19556d87` — 직접 브리지에도 ComfyUI Provider 준비 대기 5분 적용
- `03659c64aba62d2f14e1e3a900b4915761dedbd1` — 구형 Bun ImageGen 버전 상수 제거 (최신 PC 브랜치 HEAD)

### 1. `ManagedServiceSupervisor.cs`

PC 게임의 8189 이미지 API는 더 이상 별도 Bun/ImageGen 프로세스를 실행하지 않는다. Manager가 실행하는 Remote Host가 loopback 8189 API를 소유하고, 그 API가 기존 `LegacyGameImageApi`와 `ComfyUiGateway`를 통해 ComfyUI 8188에 직접 요청한다.

- Remote Host 실행 인자에 `Host:EnableGameImageApi=true`를 추가한다.
- `StartImageGenAsync`는 Bun 서버를 새로 실행하지 않고 Host가 소유한 `ComfyUI Game API`의 health/readiness를 확인한다.
- 기존 Manager 소유 Bun/ImageGen 프로세스가 남아 있는 경우, setup/reuse 전환 과정에서 소유권을 확인한 뒤 안전하게 종료하고 Host를 재시작한다.
- 외부/소유권 불명 프로세스는 종료하지 않는다. 8189 포트 충돌이 있으면 원인과 프로세스 정보를 표시하고 전환을 중단한다.
- Provider 준비 여부는 단순 서버 생존과 분리한다. ComfyUI Manager 소유 프로세스가 시작 중이면 최대 5분 동안 `Starting`으로 대기하고, 제한 시간 후에도 준비되지 않으면 `Failed`로 표시한다. 자동 종료·재시작하지 않고 프로세스 소유권을 보존한다.
- `StartAllAsync`와 기존 설정 재사용 경로에도 같은 구형 프로세스 정리 및 Host 재시작 절차를 적용한다.

### 2. `Program.cs`

- Manager가 전달한 `Host:EnableGameImageApi=true` 설정에 따라 Kestrel이 `127.0.0.1:8189` loopback listener를 추가로 연다.
- 8189 listener의 요청은 `LocalGameImageApiBridge`로 전달한다. LAN 전체에 8189를 노출하지 않는다.
- 첫 페어링 등록 및 pairing-manifest 요청이 기존 로컬 사설망 게이트에서 거절될 때는 요청 경로, 원격 주소, 거절 사유만 로그에 남긴다.
- QR nonce, 서명, bearer token, 개인키, 공개키 증명 payload는 기록하지 않는다. 기존 로컬망 제한 정책은 완화하거나 제거하지 않았다.

### 3. PC 게임 이미지 API — Bun 없이 ComfyUI 직접 사용

새 파일: `src/Wayward.RemoteHost.Server/LocalGameImageApiBridge.cs`

- 기존 게임이 사용하는 `/api/image/health`, `/api/image/generate`, `/api/image/status/{promptId}`, `/api/image/cancel`, `/api/image-hit`, `/api/pack`, batch 경로 및 `/images/*`를 loopback 8189에서 제공한다.
- 생성 요청은 기존 `LegacyGameImageApi` → `ComfyUiGateway` 경로로 전달되어 ComfyUI 8188에서 실행된다. 별도 Bun/ImageGen 런타임은 생성 경로에 필요하지 않다.
- 게임 요청의 `workflow=illustrious`에 명시적인 checkpoint나 사용자 workflow가 없으면, 기존 직접 ComfyUI 성공 테스트에서 사용한 `waiIllustriousSDXL_v170.safetensors`를 기본 checkpoint로 선택한다. 명시적인 checkpoint 및 custom workflow는 우선한다. 과거 Anima workspace 설정이 명시적 Illustrious checkpoint를 덮어쓰지 않도록 했다.
- 생성 완료 파일은 Manager가 승인한 게임 workspace의 `images/__wayward_generated__` 아래에 저장되고, `/images/*`를 통해 게임에 반환된다. workspace root는 Manager 설정에서 선택하며 임의의 폴더를 열지 않는다.
- 8189는 loopback 요청만 받으며, 브라우저 Origin도 local/file 기반 origin만 허용한다. 로컬 AWebServer에서 쓰는 `0.0.0.0` origin도 지원한다.
- 기존 `ImageGenGateway` proxy의 8189 대상은 새 Host-owned bridge로 연결된다. Android의 기존 `/v1/game-image-api` 경로는 변경하지 않고 같은 `LegacyGameImageApi`를 계속 사용한다.
- PC UI의 상태 표기를 `ComfyUI Game API`로 바꾸고, 구형 ImageGen 설정 버튼은 숨겼다.

Smoke test에는 mock ComfyUI를 이용한 게임 요청 → prompt status → 생성 이미지 파일 반환, `/api/pack`, CORS 및 Illustrious checkpoint 선택 검증을 추가했다. 다만 해당 테스트는 아직 실행하지 않았다.

### 보존한 PC 동작

다음은 변경하지 않았다.
- QR manifest의 Host 서명, Host ID, TLS 인증서 SHA-256 pin
- QR nonce의 만료 및 일회성 등록 정책
- Device 공개키 proof와 PC Manager의 명시적 승인 절차
- 페어링된 기기 레지스트리 및 명시적 해제 정책
- PC 게임 API 8189의 loopback 전용 바인딩 (이제 Remote Host 소유의 직접 ComfyUI 브리지)
- ComfyUI 8188의 기존 프로세스 소유권/종료 정책
- Android `/v1/game-image-api` 인증/요청 경로와 pairing 계약 (Android 코드 변경 없음)
- 기존 `LegacyGameImageApi` 및 `ComfyUiGateway` 구현을 재사용하며, PC 게임 요청은 새 8189 브리지로 연결

## 현재까지 확정된 사실과 미확정 항목

### ImageGen / PC 게임 초상화

- 과거 게임 브라우저가 `POST http://127.0.0.1:8189/api/image/generate`로 보낸 두 요청이 HTTP 500 `{"error":"internal error"}`를 반환한 로그가 있다. 이는 구형 8189 ImageGen 경로에서 관찰된 기록이다.
- ComfyUI 8188에 직접 제출한 별도 테스트 workflow는 prompt 완료 및 PNG 출력까지 성공했다. 이는 ComfyUI 단독 생성 성공 이력이지, 새 PC 게임 API 브리지 경유 성공 증거는 아니다.
- 새 PC 브랜치는 8189를 Remote Host가 직접 소유하도록 바꾸고, 게임 요청을 `LegacyGameImageApi` / `ComfyUiGateway`를 통해 ComfyUI 8188로 전달한다. Bun ImageGen을 새로 실행하지 않는다.
- 실제 게임 payload의 `workflow=illustrious`는 기본 checkpoint `waiIllustriousSDXL_v170.safetensors`로 연결한다. 명시적 checkpoint 또는 custom workflow가 있으면 해당 설정을 보존한다.
- 새 smoke test는 mock ComfyUI로 generate → status → 이미지 bytes 반환과 checkpoint 선택을 검사하도록 추가했지만 아직 실행하지 않았다.
- 따라서 기존 HTTP 500의 실제 원인이 새 경로에서 해결됐는지, 실제 GPU 생성이 되는지, 최종 초상화가 게임 UI에 표시되는지는 아직 미검증이다.
- 과거 `ECONNREFUSED` 기록은 현재 HTTP 500의 확정 원인으로 취급하지 않는다. 구형 `smoke-imagegen-runtime.ps1`의 health 성공만으로 새 직접 브리지의 실제 prompt 생성 성공을 판정하지 않는다.

### Pairing

- PC QR 생성은 Manager가 선택한 LAN 후보 주소를 `/v1/host/qr?address=...`로 전달한다. PC API가 주소를 임의 선택하는 구조가 아니다.
- 현재 Manager는 선택한 인터페이스/주소, gateway, listener 사전검증 결과를 로그에 남기며, listener 사전검증 성공은 Android 실제 도달성 검증을 의미하지 않는다고 표시한다.
- PC는 첫 등록 및 manifest 요청에서 동일 사설 IPv4 subnet 여부를 검사한다. 이번 변경은 이 보안 경계를 그대로 유지한다.
- Android의 최초 manifest fetch는 QR bootstrap의 `baseUrl`을 직접 사용한다. 현재 확인한 개발판의 해당 경로에는 최초 fetch를 위한 별도 주소 후보 fallback이 없다.
- Android의 `RemoteHostClient`는 QR 서명 확인, PC identity/TLS pin 검증, Device proof, 승인 대기 단계를 구분하는 Logcat 메시지를 일부 남긴다. 그러나 단계별 실패를 앱 진단 journal에 구조화해 남기는 범위는 충분하지 않다.

## Android 최소 수정 권장 diff — 반드시 최신 개발판 기준

**대상 브랜치: `work/official-dev-port` (위 기준점 참조).** 아래 경로는 이 개발판에서 확인한 파일을 기준으로 한다. 구현을 시작하기 직전 해당 브랜치 HEAD가 바뀌었는지 다시 확인하고, 새 HEAD의 실제 코드에 맞춰 최소 diff를 재계산한다.

### A. 최초 QR manifest 연결 단계의 진단 보강

파일: `app/src/main/java/com/wayward/launcher/RemoteHostClient.java`

대상 메서드: `fetchPairingManifest(RemoteHostConnection.BootstrapInfo bootstrap)`

권장 변경:
- 요청 시작/성공/실패를 `DiagnosticsLogger.event/error`에 단계별로 기록한다.
- 실패 시 예외 종류와 HTTP status, 안전하게 정제된 오류 분류만 기록한다. DNS 실패, connection refused, timeout, TLS 인증서/pin 실패, HTTP 403/404/429를 서로 구분한다.
- QR nonce, 서명, token, private key, polling secret, Device 공개키, 전체 manifest 본문은 기록하지 않는다.
- 현재 `bootstrap.baseUrl` 단일 주소로 요청한다는 사실을 그대로 관찰 가능하게 한다. 실제 대체 주소 후보가 확보되지 않은 상태에서 임의 IP fallback을 추가하지 않는다.

### B. PC identity / pairing 요청 / proof / 승인 단계의 journal 기록

파일: `app/src/main/java/com/wayward/launcher/RemoteHostClient.java`

대상 메서드:
- `verifyAndStoreQr(...)`
- `pairAndWaitForApproval(...)`
- `authenticate(...)`

권장 변경:
- 기존 Logcat stage 메시지를 없애지 말고, 동일한 단계 성공/실패를 `DiagnosticsLogger`의 구조화 이벤트로도 기록한다.
- 특히 `pc_identity_auth`, `pc_pairing_request`, `device_proof`, `user_approval_wait`, `pairing_registration`, `pc_session_auth` 각각에 대해 결과를 남긴다.
- 예외를 삼키거나 성공으로 바꾸지 않는다. 원래 예외와 사용자 표시 오류 흐름을 보존한다.
- 개인 식별이 가능한 device display name, IP 주소 전체, QR nonce 및 모든 인증 재료는 진단 이벤트에 넣지 않는다.

### C. 진단 ZIP이 실제 pairing 단계를 포함하는지 검증

파일: `app/src/main/java/com/wayward/launcher/DiagnosticsBundleExporter.java`

권장 변경:
- 위에서 추가한 journal 이벤트가 명시적 진단 ZIP에 포함되는지 확인하고 필요한 경우 pairing 관련 이벤트만 포함한다.
- Logcat 전체를 무차별로 ZIP에 추가하지 않는다. 기존 redaction 정책과 사용자 명시적 진단 내보내기 동작을 유지한다.
- PC 측 403 로그와 Android 측 요청 실패 이벤트를 시간대별로 대조할 수 있는 최소 필드(timestamp, stage, result, safe error category)를 보장한다.

### D. 진단 업로드 오류 집계 헤더의 기존 결함도 함께 바로잡기

파일: `app/src/main/java/com/wayward/launcher/DiagnosticsBundleUploader.java`

기존 조사에서 uploader가 `X-Wayward-Version`은 전송하지만 서버가 읽는 `X-Wayward-error-count`는 전송하지 않는 불일치가 확인됐다. 현재 개발판에서도 같은 코드가 유지되는지 재확인한 뒤, ZIP 내부 journal의 ERROR/WARN 집계값을 계산해 해당 헤더에 전달한다. 집계값은 진단 메타데이터일 뿐이고 이벤트 본문이나 인증정보를 헤더에 넣지 않는다.

### E. 주소 fallback을 성급히 구현하지 말 것

파일: `RemoteHostClient.java`의 `fetchPairingManifest`, `endpointCandidates` 및 관련 연결 함수

현재 QR의 `baseUrl`은 PC가 서명한 manifest의 일부다. 최초 pairing에는 아직 신뢰된 Host가 없으므로 mDNS에서 광고한 임의 주소를 신뢰 근거로 사용할 수 없다. 향후 대체 주소를 지원하려면 다음 조건을 모두 만족하는 경로만 허용한다.
- QR에서 읽은 Host ID, Host 공개키 fingerprint, TLS certificate pin을 신뢰 기준으로 유지한다.
- 후보 주소는 실제 동일 PC Host를 가리키는지 TLS pin 및 Host identity로 재검증한다.
- TLS/pin/identity mismatch에서는 절대 다른 주소로 fallback하지 않는다.
- POST 요청이 전송된 뒤에는 중복 pairing 요청을 막기 위해 자동 재시도하지 않는다.
- PC의 동일 사설망 접근 정책을 약화하지 않는다.

우선 A~D의 단계별 진단을 적용해 실패가 QR 주소 도달성인지, PC subnet gate인지, TLS pin/identity인지, nonce/Device proof인지부터 구분한다. 확인된 원인이 주소 선택인 경우에만 E를 별도 최소 diff로 설계한다.

## 완료 판정 기준

### PC 측

- `ComfyUI Game API` health에서 bridge 생존과 ComfyUI Provider ready가 UI 상태에 정확히 반영된다.
- Manager 소유 ComfyUI가 시작 중이면 최대 5분 동안 `Starting`으로 대기하고, Provider 미준비 시 프로세스가 자동 종료/재시작되지 않으며 소유권 기록이 보존된다.
- Pairing local-network gate가 거절한 요청은 비밀정보 없이 서버 로그에서 경로/원격 주소/사유를 확인할 수 있다.
- 기존 QR 서명, TLS pin, nonce, Device proof, 사용자 승인 및 명시적 revoke 흐름이 유지된다.

### ImageGen 실제 생성

- 게임에서 발생한 실제 payload를 그대로 재현해 8189의 HTTP status와 response body를 확보한다.
- 새 8189 bridge가 실제 게임 payload로 ComfyUI 8188에 prompt를 제출했는지, prompt ID가 반환됐는지, 완료됐는지 확인한다.
- 최종 출력 파일이 실제 생성되고 이미지 디코딩이 가능한지 확인한다.
- 반환된 `imageUrl`이 게임 브라우저에서 실제로 로드되고 해당 캐릭터 초상화에 반영되는지 확인한다.
- PC 브라우저 직접 경로와 Android Remote Host proxy 경로를 각각 확인한다.
- health smoke 통과만으로 생성 성공을 판정하지 않는다.

### Android 실제 pairing

- 최신 개발판 `work/official-dev-port`에서 QR scan → signed manifest → TLS/Host identity → pairing request → Device proof → PC 승인 → pairing registration → session auth의 단계별 결과가 진단 ZIP에 남는다.
- PC 로그와 Android 로그를 timestamp 및 stage로 상호 대조할 수 있다.
- 실제 Android 기기에서 페어링 성공 후 앱 재시작/PC Host 재시작 이후에도 영구 pairing 기록이 보존되고, 세션은 별도 재인증되는 기존 계약을 유지한다.
- TLS pin mismatch, 잘못된 Host, 만료/재사용 nonce, 승인 거절은 실패해야 하며 성공으로 위장하지 않는다.

## 개발 브랜치 보존 및 삭제 승인 규칙

모바일 후속 수정은 `work/official-dev-port`에서 수행한다. 정상 작동을 자동화 테스트와 실제 Android 기기에서 확인한 뒤에도 해당 개발 브랜치를 자동 삭제하지 않는다. 삭제가 안전한 시점에 도달하면 **삭제 대상 브랜치명, 검증 결과, 보존할 커밋/대체 브랜치**를 사용자에게 제시하고, **브랜치를 삭제해도 되는지 사용자의 명시적 승인을 먼저 받는다.** 승인이 있기 전에는 브랜치와 관련 작업물을 보존한다.

## 이번 작업의 검증 상태

- PC 코드 변경: 적용됨 (위 여섯 커밋; 최신 PC branch HEAD `03659c64aba62d2f14e1e3a900b4915761dedbd1`).
- Android 코드 변경: 없음. 권장 diff만 이 문서에 기록.
- PC 빌드 및 자동화 테스트: **NOT RUN**. 새 mock bridge smoke test는 추가했지만 실행하지 않았다.
- 새 8189 bridge를 통한 실제 ComfyUI GPU prompt 생성: **NOT RUN**.
- 실제 게임 초상화의 최종 UI 출력: **NOT RUN**.
- Android APK 빌드 및 물리 기기 pairing: **NOT RUN**.
- 정식 릴리스, merge, deploy: 수행하지 않음.
