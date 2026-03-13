# Kiwi v2.0 구현 체크리스트

## Phase 1: 동적 폴링
- [x] `waitUntil()` 범용 헬퍼 구현
- [x] `waitForSearchSettled()` 구현 (120ms 폴링, 연속 2회 동일 rowCount)
- [x] `waitForPopup()` 구현 (프로그레시브 백오프)
- [x] L247 `sleep(3000)` → `waitForSearchSettled()` 교체
- [x] L242 `sleep(1000)` 제거 (goBackToCal00201 내부 폴링 충분)
- [x] L259 `sleep(1000)` 제거 (enterOrg 내부 폴링 충분)
- [x] L272 `sleep(2000)` → `waitForPopup('dwldRsnPopup')` 교체
- [x] L278 `sleep(500)` → `sleep(100)` 축소
- [x] L280 `sleep(500)` 제거
- [x] 검색 결과 0건 상태 정상 처리 확인 (waitForSearchSettled에서 count >= 0 체크)

## Phase 2: 세션 Keep-Alive
- [x] `startKeepAlive()` 구현 (4분 간격)
- [x] DOM 세션연장 버튼 탐색 로직 (class/text/timer 패턴)
- [x] 확인 모달 자동 닫기
- [x] `exTime` 쿠키 갱신 (currentTime + 60분)
- [x] `checkSessionHealth()` 구현 (getSession.do + ErrorCode)
- [x] `stopKeepAlive()` 구현
- [x] runBatch 시작 시 keep-alive 시작
- [x] runBatch 종료/중지 시 keep-alive 정지
- [x] 3회 연속 실패 시 UI 경고

## Phase 3: 로그인/OTP 감지
- [x] `checkLoginState()` 구현
- [x] `/api/start`에서 로그인 확인 추가
- [x] `checkOtpModal()` 구현
- [x] OTP 감지 시 자동 일시정지
- [x] UI 로그인 상태 표시
- [x] UI OTP 경고 배너

## Phase 4: 실패 재시도
- [x] 영구 실패 vs 재시도 가능 분류 로직
- [x] 3라운드 재시도 루프 구현
- [x] `state.retryRound` 상태 추가
- [x] UI 재시도 라운드 표시

## Phase 5: 자동 네비게이션
- [x] `navigateToSangsijumgum()` 구현
- [x] Nexacro dsMenu 메뉴 탐색 시도
- [ ] mouse 클릭 fallback (실시스템 테스트 필요)
- [x] 수동 안내 최종 fallback (false 반환 시 UI 메시지)
- [x] UI "자동 이동" 버튼

## Phase 6: 일시정지/재개 + UI
- [x] `state.paused` 플래그
- [x] `POST /api/pause` 엔드포인트
- [x] `POST /api/retry-failed` 엔드포인트
- [x] runBatch 루프에 pause 체크
- [x] UI 일시정지/재개 버튼
- [x] UI 세션 상태 표시 (초록/노란)
- [x] UI 경고 배너 (OTP/세션)
- [x] 진행 텍스트에 재시도 라운드 반영

## QA
- [x] 코드 자체 리뷰 — Critical 3건, Major 3건, Minor 9건 발견
- [x] Critical #1 수정: CDP 세션 누수 — detach() 후 재생성
- [x] Critical #2 수정: keep-alive/evaluate 충돌 — 배치 실행 중 keep-alive 스킵
- [x] Critical #3 수정: start/retry 동시 실행 — _startLock 추가
- [x] Major #4 수정: findNewestXlsx 오인식 — sinceMs 필터 추가
- [x] Major #5 수정: 브라우저 연결 끊김 — isConnected() 체크 추가
- [x] Major #9 수정: 페이지 재선택 시 dialog 핸들러 재등록
- [x] Minor #18 수정: 시작 시 btnOpenFolder 숨기기
- [x] 외부 QA — Codex: P2a(_startLock 해제), P2b(retry round 0 실패 선택), P1(stale rowCount 방지)
- [x] 외부 QA — Gemini: G1(리스너 누적), G3(pollState 중복)

## 추가 기능 (세션2)
- [x] xlsx 병합 — 배치 완료 후 모든 완료 파일을 merged_YYYYMMDD.xlsx로 자동 병합
- [x] 배치 완료 알림 — 비프음(WebAudio) + 데스크탑 Notification
- [x] .crdownload 정리 — 배치 완료 시 다운로드 폴더의 임시 파일 자동 삭제
- [x] pollState 연결 오류 배너 — 3회 연속 실패 시 "서버 연결 끊김" 표시, 복구 시 자동 숨김
- [ ] 속도 비교 테스트 (실시스템)
- [ ] 세션 만료 테스트 (실시스템)
