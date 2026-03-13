# Kiwi v2.1.0 구현 컨텍스트

## 현재 상태

- **Phase**: 12 완료 (Phase 2~12 코드 작성 완료)
- **server/index.js**: v2.1.0 (974줄)
- **web/index.html**: v2.1.0 재빌드 완료
- **package.json**: version 2.1.0
- **다음**: Phase 13 테스트, Phase 14 빌드 & 배포

---

## 파일 상태 추적

| 파일 | 현재 버전 | 마지막 수정 Phase | 줄 수 |
|------|----------|------------------|-------|
| server/index.js | v2.1.0 | Phase 10 | 974 |
| web/index.html | v2.1.0 | Phase 11 | ~400 |
| package.json | 2.1.0 | Phase 12 | 47 |
| electron/main.js | 변경 없음 | - | ~42 |

---

## v2.1.0 구현 요약

### Phase 1: stamp 기반 폴링
- `waitSearchSettled()` — stamp=count|firstIeNm, 120ms 폴링, 2회 동일 시 settled
- `waitReasonInputReady()` — dwldRsnPopup 감지, 120ms 폴링
- sleep 6개 중 4개 제거, 2개 교체

### Phase 2: WSL 경로 변환
- state.cdpDownloadPath 추가
- `/mnt/c/` → `C:\` 자동 변환
- 한글 파일명 latin1→utf8 수정

### Phase 3: 세션 Keep-Alive
- 4분 간격 doKeepAlive()
- 상단 120px 세션 버튼 탐색+클릭
- 확인 모달 leaf-node 닫기
- exTime 쿠키 갱신
- 3회 실패 시 경고

### Phase 4: 로그인/OTP 감지
- checkLoginState() — window._application + 로그아웃 텍스트
- checkOtpModal() — nexacro 팝업 + DOM 모달
- /api/start에서 로그인 확인

### Phase 5: 자동 네비게이션
- navigateToSangsijumgum() — ezbaro 탭 찾기 → fnCalMenuMove
- POST /api/navigate 엔드포인트
- ezbaro 우선 매칭 (v1.0.3 버그 수정)

### Phase 6: 재시도 (3라운드)
- runBatchWithRetry() — MAX_RETRY_ROUNDS=3
- runBatch(indices) — 인덱스 배열 기반
- isRetryable() — PERMANENT_FAILURES 제외
- _startLock 동시 실행 방지
- POST /api/retry-failed 엔드포인트

### Phase 7: 일시정지/재개
- POST /api/pause — 토글
- runBatch 루프 내 while(paused) 체크
- OTP 감지 → 자동 일시정지 + alert
- POST /api/dismiss-alert

### Phase 8: 병합 + 정리
- mergeDownloadedFiles() — xlsx 합치기, 컬럼 불일치 skip
- cleanupCrdownloads() — .crdownload 삭제
- findNewestXlsx(dir, sinceMs) — sinceMs 이후 파일만

### Phase 9: runBatch 안정성
- CDP 세션 detach + 재생성 (리스너 누적 방지)
- 브라우저 끊김 감지 + alert
- ezbaro 페이지 재선택
- downloadStartTime 추적

### Phase 10: /api/state 확장
- paused, retryRound, sessionOk, loginOk, alert, mergedFile 추가

### Phase 11: web/index.html
- 경고 배너, 로그인 상태, 세션 인디케이터
- 자동 이동, 일시정지, 재시도 버튼
- Web Audio 비프 + Notification API
- isPolling anti-overlap
- 버전 v2.1.0

### Phase 12: package.json
- version 2.1.0

---

## v1.0.3 베이스 코드 구조 (server/index.js)

### 글로벌 변수
- `state`: { downloadDir, tasks, fileName, browserConnected, running, currentIdx, results }
- `browser`, `page`, `cdpSession`

### 함수 목록 (순서대로)
1. `sanitizeFilename(name)` — L15-21
2. `app.get('/api/state')` — L40-58
3. `app.post('/api/set-download-dir')` — L60-69
4. `app.post('/api/upload')` — L71-96
5. `app.post('/api/browser/launch')` — L98-157
6. `app.get('/api/browser/status')` — L159-163
7. `app.post('/api/start')` — L165-179
8. `app.post('/api/stop')` — L181-184
9. `runBatch()` — L188-316
10. `isOnCal00202()` — L320-329
11. `goBackToCal00201()` — L331-351
12. `searchTask(taskNo, year)` — L353-381
13. `getSearchResults()` — L383-399
14. `enterOrg(rowIdx)` — L401-419
15. `clickExcelDownload()` — L421-434
16. `fillDownloadReason()` — L436-448
17. `getDatedFilename()` — L452-456
18. `findNewestXlsx(dir)` — L458-470
19. `sleep(ms)` — L472-474
20. `findChromePath()` — L476-486
21. `module.exports.start(port)` — L489-497

---

## Ezbaro Downloader 역분석 결과 (반드시 참조)

### 왜 빠른가
- `EZBARO_SEARCH_POLL_SEC = 0.12` (120ms)
- stamp: `${rowExists}|${rowCount}|${firstId}|${firstText}|${noResult}`
- 연속 2회 동일 stamp → settled → 즉시 진행
- **타임아웃 시 throw 안 함** — 이게 이전 v2.0 실패의 핵심 원인

### 채용한 패턴
1. stamp 기반 검색 settled (120ms 폴링)
2. stamp 기반 상세 진입 감지
3. 다운로드 사유 input ready 폴링
4. 타임아웃 시 절대 throw 안 함

### 채용하지 않은 패턴
- DOM 좌표 클릭 (page.mouse.click) → Kiwi는 Nexacro API 직접 호출 유지
- 파일 크기 폴링 → Kiwi는 CDP 이벤트 유지 (더 정확)

---

## 이전 v2.0 실패 교훈 (반드시 참조)

1. `waitForSearchSettled`가 `prevKnownCount`로 stale 판별 → 복잡하고 불안정
2. stamp가 `rowCount`만 사용 → 불안정 (같은 count지만 다른 데이터일 수 있음)
3. 타임아웃 시 `throw Error` → 배치 중단 → 사용자 경험 최악
4. `waitForPopup`도 throw → 다운로드 실패
5. 결과: 건당 36초 (v1.0.3의 5배 느림)

---

## 호환성 체크포인트

### v1.0.3에서 유지한 것
- Nexacro API 접근 방식 (window._application.gvWorkFrame.frames)
- CDP Browser.downloadWillBegin / downloadProgress 이벤트
- GUID 기반 다운로드 추적
- sanitizeFilename 로직
- Chrome port 9446
- Express 서버 구조

### v1.0.3 버그 수정 완료
- L147: `gaia|ezbaro` → ezbaro 우선 매칭 (Phase 5)
- L91: `req.file.originalname` 한글 깨짐 → latin1→utf8 (Phase 2)
- L192: `downloadPath: state.downloadDir` WSL 경로 → cdpDownloadPath (Phase 2)
- `findNewestXlsx` sinceMs 추가 (Phase 8)

---

## 세션 간 인수인계 메모

### Phase 0 완료 (2026-03-13)
- v1.0.3 코드 복원 확인 (server/index.js 498줄, web/index.html 377줄)

### Phase 1 완료 (2026-03-13)
- stamp 폴링 함수 2개 추가, sleep 6개 교체/제거
- 구문 검사 통과

### Phase 2~12 완료 (2026-03-13)
- server/index.js 974줄 (구문 검사 통과)
- web/index.html 완전 재빌드
- package.json version 2.1.0
- 모든 엔드포인트 구현: state, set-download-dir, upload, browser/launch, browser/status, start, stop, navigate, pause, retry-failed, dismiss-alert
