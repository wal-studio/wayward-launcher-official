# Android A/B 통합 포렌식 기록 (2026-11-27)

## 대상과 기준점

- 공식 APK 빌드 대상: `wal-studio/wayward-launcher-official`
- 기존 빌드 계보: `work/wal-android-release-builder-20261120`
- 기준 커밋: `059ca879e94f9f97c57c061da0dec7e4141121dc`
- A 계보: `work/imagegen-request-fidelity-20261126`, 기준 변경 커밋 `3d01037dd5d0d14873b24266b25aec38c20dc769`, 최신 확인 커밋 `da3a0649b479809e766f88754679039893cec145`
- B 계보: `hotfix/profile-picker-session-isolation-20261125`, 최종 커밋 `1d4bbfe97c03a7dc572448f52cb68ca92412cbcd`
- A/B 공통 조상: `2af1eaa688fb30dfbbd9b5a23b82210631f58c4e`

A/B는 같은 공통 조상에서 갈라진 별도 계보이며, 한쪽이 다른 쪽의 후손은 아니다. 따라서 한쪽 전체를 덮어쓰는 방식은 사용하지 않고 기능 영역별로 선별 통합한다.

## A에서 가져온 제품 기능과 안전성 개선

- `ImageGenProxy`: 게임의 `POST /api/image/generate` 본문을 JSON 재직렬화하거나 workflow를 강제로 덮어쓰지 않고 원문 바이트로 로컬 ImageGen 엔진에 전달.
- NAI 엔진: NAI 모델, 크기, steps, guidance, sampler, noise schedule, 공통/작가/부정 프롬프트를 저장 설정에서 읽고, 사용자 seed를 생성 요청 및 캐시 해시에 반영. NAI 모드에서 Comfy 전용 LoRA/checkpoint 등은 capabilities 응답의 unsupportedSettings로 명시하며 허위 적용하지 않음.
- 직접 NAI API 경로: Android Keystore 소유 토큰을 Authorization 헤더에만 주입하고, 게임 요청 본문은 그대로 전달.
- ImageGen backend 설치/복구: 번들 manifest 무결성 검사와 APK 복구 smoke test, 진단 이벤트 보강.
- Remote Play: 등록 세대(timestamp) 기반 폐기 처리, revocation stream, 오래된 요청이 새 페어링을 지우지 못하도록 하는 보호, 원격 생성 이미지 리소스 경로.
- 이미지 CDN fallback: 원본 이미지 서명 검사/디코딩 검증, 리다이렉트·경로 제한, 기존 로컬/생성 모드 정책 유지.
- 진단 로그: 전체 예외 스택 보존, 보관 회전, 민감정보 마스킹.
- 관련 문서/테스트 및 Worker 소스.

## B에서 가져온 제품 기능과 안전성 개선

- 프로필 폴더 선택 시 현재 활성 게임 세션의 `activeProfileId`, `treeUri`, `tree`를 변경하지 않도록 수정. 프로필 목록의 저장만 수행.
- 진단 ZIP 생성/전송 전에 명시적 사용자 동의를 요구하고, 동의 전 자동 업로드 경로 제거.
- 공식 업데이트 알림의 버전별 dismiss, stable release 선별, manifest/package/version/hash/signer 검증, 중복 다운로드 방지 및 설치 권한 흐름.
- 관련 회귀 테스트와 동의/업데이트 문서.

## 통합 결정

- A의 ImageGen/NAI/Remote Play/진단 보존 코드를 제품 기준으로 사용.
- B의 `OfficialUpdateManager`와 업데이트 단위 테스트를 사용.
- `MainActivity`는 A의 revocation-generation guard, 원격 이미지 경로, 선택된 이미지 모드 기준 라우팅을 보존하면서 B의 진단 동의 UI, 업데이트 확인 UI, 프로필 세션 격리 수정을 결합.
- CDN URL은 A의 제한된 host/path/확장자/응답 검증 및 이미지 모드 가드를 유지하고, B가 추가한 `/images/illustrious/characters/<character>/...` 경로도 허용. B의 무조건적 외부 fallback은 이미지 모드 격리와 충돌하므로 그대로 이식하지 않음.
- A의 NAI seed 포함 캐시 해시를 사용. B의 구형 seed-less 해시 구현은 채택하지 않음.
- 공식 저장소의 Android Maven mirror 설정, Gradle 메모리 설정, 공식 릴리즈 패키징 스크립트, 공식 빌드 버전은 보존. B 개발판의 1.0.1 버전 설정은 공식 1.0.0 빌드 계보에 덮어쓰지 않음.
- A/B의 self-hosted runner 및 저장소 동기화 workflow는 가져오지 않음. 새 브랜치 생성/기존 브랜치 병합/공개 릴리즈 생성은 하지 않음.
- backend 0.8.4의 43개 소스/리소스 파일을 A 계보의 검증된 bundle manifest와 함께 공식 저장소에 그대로 고정(vendored)하여 APK에 포함. CI는 더 오래된 mods.zip으로 이를 덮어쓰지 않고 bundle hash를 검증한다. 기존 `embed_imagegen_backend.py`는 복구용으로 남기되, 검토 없이 기존 bundle을 덮어쓰지 못하도록 기본 동작을 보호.

## 검증 범위와 명시적 한계

- CI에서 Node 계약 테스트, Bun 기반 NAI 요청 payload mock 테스트, Gradle 단위 테스트, Android 15 emulator instrumentation/UI smoke, 공식 variant 서명/패키지 검증과 서명된 공식 APK의 API 35 설치·실행 smoke를 수행하도록 구성.
- NAI payload mock은 실제 NovelAI 계정 호출 없이 request body와 응답 bytes 전달을 검증한다. 실제 사용자 토큰으로 실제 초상화를 생성하는 실기기 end-to-end는 해당 토큰과 게임 세션이 없어 이 CI만으로 증명할 수 없다.
- PC 게임 요청을 PC Host가 Android NAI 엔진으로 전달하는 역방향 job transport는 A 계보 문서에서도 미완료로 명시되어 있다. 이 Android APK 작업은 기존 로컬 Android NAI 파이프라인을 검증하며, 미구현 PC→모바일 NAI transport를 완료했다고 주장하지 않는다.
- Cloudflare Worker 소스는 저장소에 포함하되 배포하지 않는다. 공개 릴리즈/Worker 배포는 별도 승인 대상이다.
