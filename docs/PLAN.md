# Kiwi v2.0 구현 계획

## 상태: Phase 1~6 구현 완료, 자체 QA + 외부 QA 완료, 실시스템 테스트 대기

---

## Phase 1: 동적 폴링 (속도 3-4배 향상)
- **상태**: [x] 완료
- `waitUntil()` — 프로그레시브 백오프 [0, 20, 50, 100, 100, 500]ms
- `waitForSearchSettled()` — 120ms 간격 폴링, 연속 2회 동일 rowCount
- `waitForPopup()` — 팝업 감지 폴링
- sleep(3000) → waitForSearchSettled, sleep(2000) → waitForPopup
- sleep(1000) x 2개 제거, sleep(500) → sleep(100), sleep(500) 제거

## Phase 2: 세션 Keep-Alive
- **상태**: [x] 완료
- `startKeepAlive()` / `stopKeepAlive()` — 4분 간격
- DOM 세션연장 버튼 탐색 (class/text/timer 패턴, y < 120px)
- exTime 쿠키 갱신 (currentTime + 60분)
- `checkSessionHealth()` — getSession.do + ErrorCode
- 3회 연속 실패 시 UI 경고

## Phase 3: 로그인/OTP 감지
- **상태**: [x] 완료
- `checkLoginState()` — window._application + 로그아웃 텍스트
- `checkOtpModal()` — nexacro 팝업 + DOM 모달 탐색
- 배치 시작 전 로그인 확인, OTP 감지 시 자동 일시정지

## Phase 4: 실패 재시도 (3라운드)
- **상태**: [x] 완료
- `runBatchWithRetry()` — 3라운드 루프
- 영구 실패: UUID 패턴, 기관 매칭 실패
- 재시도 가능: 시간 초과, 클릭 실패, rename 실패

## Phase 5: 자동 네비게이션
- **상태**: [x] 완료
- `navigateToSangsijumgum()` — Nexacro dsMenu 탐색 → formOpen
- 실패 시 false 반환 → UI 수동 안내
- `/api/navigate` 엔드포인트 + UI "자동 이동" 버튼

## Phase 6: 일시정지/재개 + UI
- **상태**: [x] 완료
- `POST /api/pause`, `/api/retry-failed`, `/api/dismiss-alert`
- 세션 상태 표시 (초록/노란 점)
- 로그인 상태 표시
- OTP/세션 경고 배너
- 일시정지/재개 버튼
- 실패분 재시도 버튼
- 재시도 라운드 표시

---

## 수정 파일
| 파일 | Phase | 줄 수 |
|------|-------|------|
| `server/index.js` | 1-6 | 499 → ~650 |
| `web/index.html` | 3, 6 | 378 → ~420 |

## 진행 로그
| 날짜 | Phase | 작업 내용 | 결과 |
|------|-------|-----------|------|
| 03-13 | 1-6 | 전체 구현 | 구문 검증 통과 |
| 03-13 | QA | 자체 QA: Critical 3 + Major 3 수정 완료 | 완료 |
| 03-13 | QA | 외부 QA: Codex P2a/P2b/P1 + Gemini G1/G3 수정 | 완료 |
