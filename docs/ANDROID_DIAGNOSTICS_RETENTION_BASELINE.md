# Android 진단 기준점 및 Cloudflare 보관 정책

## 보존 기준
- CAPTCHA 작업 직전 개발 기준 브랜치: `work/diagnostics-only-auto-update-20261120`
- 기준 커밋: `ed9ffbe3977b4a1fe815bab324af02a15adde4d1`
- 버전: `1.0.9`, versionCode `109`
- 이 커밋은 CAPTCHA 테스트 지원 커밋 `9d4c802e2aea4aef9f4d498fd2d6cd011173daaa`의 직접 부모다.
- 테스트용 CAPTCHA 코드는 `test/novelai-captcha-onetime-20261121` 및 후속 `fix/novelai-captcha-*` 브랜치에만 유지하고 공식 기준에 병합하지 않는다.

## 진단 강화
- `imagegen_backend_install_failed`: APK 자산 확인, 설치 경로 준비, 복사, 검증, 교체 단계.
- `imagegen_backend_prepare_failed`: 백엔드 설치 후 런타임 설정 준비 단계.
- `imagegen_service_start_requested` / `imagegen_service_start_failed`: 서비스 요청 전달 및 실패 단계.
- `imagegen_runtime_start_failed`: Bun/서버 프로세스/헬스 준비 중 런타임 실패.
- 예외 클래스·메시지·전체 스택은 기존 진단 ZIP에 포함되는 `exception-stacks.ndjson`에 기록한다.
- ZIP metadata에는 앱 버전/versionCode, Android release/SDK, APK backend asset 존재 여부, 설치 대상 상대 경로, 디렉터리 존재/쓰기 가능 여부, 설치 검증 상태를 기록한다.
- 기존 Cloudflare Worker와 `/v1/ticket`, `/v1/upload` 경로를 그대로 사용한다. Git 진단 전송은 구현하지 않는다.

## Cloudflare 보관 자동 정리
- Worker `wayward-diagnostics-ingest`, D1 `wayward-diagnostics-db`, R2 `wayward-diagnostics-private` 유지.
- 읽기 전용 측정에 기존 `wayward-save-share-files` R2 bucket binding을 추가한다. 새 bucket/database/worker는 만들지 않는다.
- 사용자가 지정한 운영상 순간 저장량 기준은 10,000,000,000 bytes (10 GB), 정리 시작 90% (9,000,000,000 bytes), 목표 85% (8,500,000,000 bytes). Cloudflare의 청구 기준은 별도의 GB-month 평균이다.
- 엄격한 `reports/<install-id>/<YYYY-MM>/<submission-id>.zip` 키만 삭제 후보.
- 업로드 15분 유예, D1 submission 행 및 R2 metadata/size/hash 일치, 활성 ticket 제외, 최신 10건 보존.
- D1 lock lease로 중복 실행 방지. R2 삭제 성공 뒤에만 submissions 행 삭제. 실패/중단 상태는 D1 cleanup item에 남겨 다음 실행에서 복구.
- 진단 ZIP만 삭제해도 85% 목표에 도달할 수 없는 경우에는 삭제하지 않는다. 비진단 R2 객체는 어떤 경우에도 삭제하지 않는다.
- Worker의 자동 사용량 측정은 기존 두 R2 bucket의 전체 object listing 합계다. 이는 순간 저장량 가드이며 Cloudflare 청구 GB-month와 동일하지 않다. 목록 조회 실패/페이지 누락 시 삭제하지 않는다.

## Cloudflare 실측 (2026-11-21)
- Cloudflare R2 account metrics Standard payloadSize: `14,873,014,485 bytes`.
- 기존 두 R2 bucket listing 합계: `14,873,016,161 bytes` (진단 bucket `14,872,704,660` + save bucket `311,501`). 이는 순간 object bytes다.
- 진단 ZIP prefix `reports/`: 57 objects, `455,374 bytes`.
- 비진단 `artifacts/`: 2,416 objects, `14,872,249,286 bytes`.
- 현재 10GB 기준 초과 원인은 진단 ZIP이 아니라 기존 artifact objects다. 해당 데이터는 작업 범위 밖이므로 삭제하지 않는다. 진단 ZIP만으로 85% 목표에 도달할 수 없으므로 자동 정리기는 현재 자료를 삭제하지 않고 차단 사유를 기록한다.
- 11월 16~20일 R2 daily max 합계는 약 `46.23 GB-days`, 30일 평균으로 환산한 해당 기간 관측분은 약 `1.54 GB-month`다. 월 최종 청구량은 아니며 이후 일별 사용량에 따라 달라진다. Cloudflare의 무료 R2 allowance는 Standard storage `10 GB-month`, Class A `1,000,000`, Class B `10,000,000` operations/month다.
- D1 `wayward-diagnostics-db` file_size: `110,592 bytes`; submissions 57 rows, indexed ZIP bytes `455,374`.
- 11월 1~21일 Workers requests `117`, errors `2`; D1 read/write queries `294/320`, rows read/written `5,611/824`; R2 Class A/B operations `4,353/9,018`.
- Workers 요청량 Analytics는 별도 API 확인 전 미확인으로 남긴다.
