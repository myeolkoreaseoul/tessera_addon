# Kiwi v2.1.0 구현 계획 — v1.0.3에서 완전 재빌드

## 상태: Phase 0 완료 (v1.0.3 코드 복원)

---

## 배경

- Kiwi v1.0.3 (commit f38cc64, 498줄): 작동하지만 느림, 세션 유지 없음
- Ezbaro_Downloader.exe (동료작, Python): stamp 폴링(120ms)으로 빠름
- v2.0.1~2.0.5 시도: 실패 — 동적 폴링이 throw로 배치 중단, 오히려 느려짐
- **이번**: v1.0.3 베이스 복원 → 기능을 Phase별로 하나씩 쌓아올림

## Ezbaro Downloader 역분석 핵심

1. 고정 sleep 대신 **stamp 기반 폴링** (120ms 간격)
2. stamp = `rowExists|rowCount|firstId|firstText|noResult` — 연속 2회 동일 시 settled
3. **타임아웃 시 throw 안 함** — 그냥 진행 (이전 실패 원인이 바로 이것)
4. 다운로드 사유 팝업도 폴링으로 감지

---

## Phase 0: v1.0.3 코드 복원 ✅

```bash
git show f38cc64:server/index.js > server/index.js   # 498줄
git show f38cc64:web/index.html > web/index.html       # 377줄
```

---

## Phase 1: 속도 개선 — stamp 기반 폴링

**파일**: `server/index.js`

### 1-1. `waitSearchSettled(maxWait=10000)` 함수 추가
- 위치: `sleep()` 함수 아래
- stamp: `${count}|${firstIeNm.slice(0,20)}`
- 120ms 폴링, 연속 2회 동일 시 return
- **타임아웃 시 throw 없음** — 그냥 return

### 1-2. `waitReasonInputReady(maxWait=5000)` 함수 추가
- nexacro.getPopupFrames()에서 `dwldRsnPopup` 감지
- 120ms 폴링
- **타임아웃 시 throw 없음**

### 1-3. runBatch() 내 sleep 교체

| 위치 | v1.0.3 | v2.1.0 |
|------|--------|--------|
| goBack 후 L242 | `sleep(1000)` | 제거 |
| searchTask 후 L247 | `sleep(3000)` | `waitSearchSettled(10000)` |
| enterOrg 후 L259 | `sleep(1000)` | 제거 |
| clickExcelDownload 후 L272 | `sleep(2000)` | `waitReasonInputReady(5000)` |
| 다운로드 폴링 L276-278 | `sleep(500) × 60` | `sleep(200) × 150` |
| 다운로드 완료 후 L280 | `sleep(500)` | 제거 |

---

## Phase 2: WSL 경로 변환

**파일**: `server/index.js`

### 2-1. state에 `cdpDownloadPath: ''` 추가
### 2-2. `/api/set-download-dir`에서 `/mnt/c/` → `C:\` 변환
### 2-3. CDP `downloadPath`에 `state.cdpDownloadPath || state.downloadDir` 사용

---

## Phase 3: 세션 Keep-Alive

**파일**: `server/index.js`

### 3-1. 글로벌: `KEEPALIVE_INTERVAL_MS=240000`, `_keepAliveTimer`, `_keepAliveFailCount`
### 3-2. state에 `sessionOk: true`, `alert: null` 추가
### 3-3. `startKeepAlive()`, `stopKeepAlive()`, `doKeepAlive()` 함수 3개
- 상단 120px 세션 버튼 탐색+클릭
- 확인 모달 leaf-node 닫기
- exTime 쿠키 갱신
- 배치 중(`running && !paused`) 스킵
### 3-4. `/api/browser/launch`에서 `startKeepAlive()` 호출
### 3-5. `/api/stop`에서 `stopKeepAlive()` 호출

---

## Phase 4: 로그인/OTP 감지

**파일**: `server/index.js`

### 4-1. state에 `loginOk: false`, `paused: false` 추가
### 4-2. `checkLoginState()` 함수 — window._application + 로그아웃 텍스트 확인
### 4-3. `checkOtpModal()` 함수 — nexacro 팝업 + DOM 모달 OTP 감지
### 4-4. `/api/browser/launch` 응답에 `loginOk` 포함
### 4-5. `/api/start`에서 로그인 확인 후 진행

---

## Phase 5: 자동 네비게이션

**파일**: `server/index.js`

### 5-1. `waitUntil(condFn, opts)` 범용 대기 함수
### 5-2. `navigateToSangsijumgum()` 함수
- ezbaro 탭 찾기 → 없으면 gaia에서 goto
- fnCalMenuMove('MCAL010200', 'MCAL010203')
- cal00201 폼 로드 대기
- 반환: true | 'need_login' | false
### 5-3. `POST /api/navigate` 엔드포인트

---

## Phase 6: 재시도 (3라운드)

**파일**: `server/index.js`

### 6-1. `MAX_RETRY_ROUNDS=3`, `PERMANENT_FAILURES`, `_startLock`
### 6-2. state에 `retryRound: 0`, `mergedFile: null`, `_stoppedManually: false` 추가
### 6-3. `isRetryable(reason)` 함수
### 6-4. `runBatchWithRetry()` 함수 — 3라운드 루프 + 완료 후 병합/정리
### 6-5. `runBatch()` 시그니처 변경: `runBatch(indices)`
### 6-6. `/api/start` → `runBatchWithRetry()` 호출 + `_startLock`
### 6-7. `POST /api/retry-failed` 엔드포인트

---

## Phase 7: 일시정지/재개

**파일**: `server/index.js`

### 7-1. `POST /api/pause` 엔드포인트 — state.paused 토글
### 7-2. runBatch 루프에 `while(paused && running) sleep(500)` 체크
### 7-3. OTP 감지 시 자동 일시정지 + alert 설정
### 7-4. `POST /api/dismiss-alert` 엔드포인트

---

## Phase 8: 병합 + 정리

**파일**: `server/index.js`

### 8-1. `mergeDownloadedFiles(dir, results)` — xlsx 합치기
### 8-2. `cleanupCrdownloads(dir)` — .crdownload 삭제
### 8-3. `findNewestXlsx(dir, sinceMs)` — sinceMs 파라미터 추가

---

## Phase 9: runBatch 안정성

**파일**: `server/index.js`

### 9-1. CDP 세션 정리 (detach + 재생성, 리스너 누적 방지)
### 9-2. 브라우저 연결 끊김 감지
### 9-3. ezbaro 페이지 재선택
### 9-4. `downloadStartTime` 추적

---

## Phase 10: /api/state 응답 확장

paused, retryRound, sessionOk, loginOk, alert, mergedFile 추가

---

## Phase 11: web/index.html 재빌드

### 11-1. CSS: warning dot, alert-banner, badge-retry, badge-paused, session-indicator
### 11-2. HTML: 로그인 상태, 세션 인디케이터, 자동 이동 버튼, 경고 배너, 일시정지/재시도 버튼
### 11-3. JS: autoNavigate, togglePause, retryFailed, dismissAlert, showAlert/hideAlert, notifyBatchDone, pollState 확장, isPolling, AudioContext, Notification
### 11-4. 버전 표시 v2.1.0

---

## Phase 12: package.json

version → "2.1.0"

---

## Phase 13: 테스트

### 13-1. 서버 기동 테스트
### 13-2. 5건 실다운로드 (속도 측정)
### 13-3. 병합 확인
### 13-4. 빌드 (`electron-builder --win`)

---

## Phase 14: 배포

### 14-1. Git commit + push
### 14-2. GitHub 릴리즈
