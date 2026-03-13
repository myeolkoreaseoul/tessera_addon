# Kiwi v2.0 작업 유의사항 & 빠진 것 확인

## 핵심 유의사항

### 1. Nexacro 프레임워크 특성
- `grid.focus(row)` 사용 필수 (`selectRow` → `getFocusedRow` = null 버그)
- 현재 Kiwi는 `ds.set_rowposition(idx)` 사용 — focus 버그와 무관하지만 주의
- Nexacro 메뉴: 좌표 기반 `page.mouse.move()` 필요할 수 있음

### 2. CDP 포트/프로파일 충돌
- Kiwi: 포트 9446, 프로파일 `~/kiwi-chrome-data`
- tessera: 포트 9446, 프로파일 `~/.tessera/profiles/ezbaro`
- **동시 실행 시 충돌** — 현재는 문제 없으나 향후 주의

### 3. 세션 관련
- GAIA/이지바로 세션 = **5분** (사용자가 1시간이라고 했지만 실제는 5분)
- `/usr/getSession.do` → 200 반환해도 XML ErrorCode 확인 필수
- `exTime` 쿠키: 클라이언트 타이머 가능성 → 쿠키 갱신이 backup
- keep-alive 3회 연속 실패 시 → UI 경고 필수

### 4. OTP 관련
- OTP는 로그인 시 수동 (자동화 불가)
- 세션 만료 후 재로그인 시 OTP 다시 요구 가능
- 배치 중 OTP 모달 감지 → 일시정지가 유일한 대안

### 5. 동적 폴링 교체 시 주의
- `goBackToCal00201()` 내부에 이미 500ms 폴링 있음 → 외부 sleep 제거만
- `enterOrg()` 내부에 이미 500ms 폴링 있음 → 외부 sleep 제거만
- `waitForSearchSettled()`: 연속 2회 동일 rowCount 필수 (flickering 방지)
- 검색 결과 0건도 정상 결과 → "0건" 상태 감지 필요

### 6. 다운로드 추적
- CDP GUID 기반 추적은 이미 우수 → 유지
- `findNewestXlsx` fallback도 유지 (sinceMs 필터 추가됨)
- 다운로드 폴링 간격: 500ms → 100ms로 줄여도 안전 (이벤트 기반)

### 7. 자동 네비게이션 리스크
- `formOpen('cal00201')` API가 존재하지 않을 수 있음
- 메뉴 구조가 배포/버전마다 다를 수 있음
- **반드시 graceful fallback** 구현 (실패해도 수동 안내로 전환)
- 현재 구현: dsMenu 탐색 → formOpen 시도 → 실패 시 false → UI 수동 안내

### 8. QA에서 발견된 아키텍처 유의사항 (세션1 추가)
- **CDP 세션은 반드시 detach 후 재생성** — 리스너 누적 방지
- **keep-alive는 배치 실행 중 스킵** — page.evaluate 직렬화 충돌 방지
  - 즉, 배치 실행 중에는 keep-alive가 돌지 않으므로 **배치 자체가 5분 넘게 idle이면 세션 만료 가능**
  - 현실적으로 배치는 건당 2~3초이므로 문제없지만, 일시정지 상태에서는 keep-alive가 다시 동작함
- **_startLock 패턴** — async 검증 사이 레이스 방지용 동기 플래그
- **페이지 재선택 시 dialog 핸들러 재등록 필수** — CDP 세션은 특정 page에 바인딩됨
- **findNewestXlsx는 downloadStartTime 이후 파일만** — 오인식 방지

### 10. 외부 QA 수정사항 (세션2 추가)
- **Codex P2a**: `_startLock`이 `/api/start` 조기 반환 시 해제 안 됨 → 모든 실패 경로에 `_startLock = false` 추가
- **Codex P2b**: `/api/retry-failed` → `runBatchWithRetry()` round 0이 '대기'만 선택, '실패' 무시 → round 0에서 '실패'+retryable도 선택하도록 수정
- **Codex P1**: `waitForSearchSettled()`가 이전 검색과 동일 rowCount면 stale 데이터에 즉시 settle → `prevKnownCount` 파라미터 추가, 검색 전 현재 count 캡처하여 전달
- **Gemini G1**: cdpSession 이벤트 리스너 누적 → `removeAllListeners()` 후 detach (자체 QA #1과 병합)
- **Gemini G3**: pollState 요청 중복 → 프론트엔드 `isPolling` 플래그 추가

### 9. 실시스템 테스트 필요 사항 (세션1 추가)
- 세션 연장 버튼의 실제 DOM 구조 확인 (class/text 패턴이 맞는지)
- getSession.do 응답 XML 실제 포맷 확인
- exTime 쿠키가 실제로 존재하는지, 서버가 읽는지 확인
- Nexacro dsMenu 데이터셋의 실제 컬럼명 확인 (menuId? MENU_ID?)
- 배치 50건+ 돌려서 세션 만료 없이 완료되는지 확인

---

## 빠진 것 확인 목록

- [x] 다운로드 실패 시 `.crdownload` 파일 정리 → 배치 완료 시 자동 삭제
- [x] 병합(merge) 기능 → 배치 완료 후 merged_YYYYMMDD.xlsx 자동 생성
- [x] 배치 완료 알림 → 비프음(WebAudio) + 데스크탑 Notification
- [x] pollState 연속 실패 시 연결 오류 배너 표시 → 3회 연속 실패 시 표시
- [x] 진행 중 브라우저 닫힘 감지 → Major #5로 구현 완료 (자동 재연결은 미구현)
- [ ] `sanitizeFilename`에서 한글 처리 검증
- [ ] 대량 배치(500건+) 시 메모리 사용량 모니터링
- [ ] Electron 빌드 후 동작 확인 (개발 모드와 차이 가능)
- [x] pollState 연속 실패 시 연결 오류 배너 표시 (세션2에서 구현)
- [ ] dialog 핸들러 중복 등록 방지 (Minor #13)
- [ ] getDatedFilename 타임존 이슈 (Minor #14, 단일 사용자 도구라 저위험)

---

## Ezbaro_Downloader에서 흡수한 장점
- [x] 프로그레시브 백오프 폴링 패턴: `[0, 20, 50, 100, 100, 500]`
- [x] 검색 완료 감지: 연속 동일 rowCount
- [x] 3라운드 재시도
- [x] 로그인 상태 감지 (배치 전 확인)
- [x] 로그인만 하면 자동으로 상시점검 화면 이동 (Phase 5)
- [x] 전체 xlsx 병합 기능 (세션2에서 구현)

## Ezbaro_Downloader 단점 (우리가 이미 더 나은 것)
- Kiwi: CDP GUID 기반 다운로드 추적 (더 정확)
- Kiwi: Electron GUI (tkinter보다 현대적)
- Kiwi: 실시간 진행 상태 웹 UI
- Kiwi: 세션 keep-alive 3중 전략 (경쟁 도구는 세션 관리 없음)
- Kiwi: OTP 모달 자동 감지 + 일시정지

---

## 세션별 변경 이력

### 세션 1 (2026-03-13)
- Phase 1~6 전체 구현
- 자체 QA: Critical 3건 + Major 3건 + Minor 1건 수정
- 3종 문서 생성 및 업데이트
- 남은 것: 외부 QA, 실시스템 테스트

### 세션 2 (2026-03-13)
- 외부 QA: Codex 3건 (P2a, P2b, P1) + Gemini 2건 (G1, G3) 수정
- P2b: retry-failed round 0에서 '실패' 상태 선택 안 되던 버그 수정
- P1: waitForSearchSettled stale 데이터 방지 (prevKnownCount 파라미터)
- 추가 기능 4건 구현:
  - xlsx 병합: 배치 완료 후 merged_YYYYMMDD.xlsx 자동 생성
  - 배치 완료 알림: 비프음(WebAudio) + 데스크탑 Notification
  - .crdownload 정리: 배치 완료 시 임시 파일 자동 삭제
  - pollState 연결 오류 배너: 3회 연속 실패 시 표시, 복구 시 자동 숨김
- 구문 검증 통과
- 남은 것: 실시스템 테스트
