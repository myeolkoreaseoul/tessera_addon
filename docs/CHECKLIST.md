# Kiwi v2.1.0 구현 체크리스트

> v1.0.3 (commit f38cc64)에서 완전 재빌드. 이전 v2.0 체크리스트 폐기.

---

## Phase 0: v1.0.3 코드 복원
- [x] `git show f38cc64:server/index.js > server/index.js`
- [x] `git show f38cc64:web/index.html > web/index.html`
- [x] server/index.js 498줄 확인
- [x] web/index.html 377줄 확인

---

## Phase 1: 속도 개선 — stamp 기반 폴링

### 코드 작성
- [x] `waitSearchSettled(maxWait=10000)` 함수 추가
  - [x] stamp: `${count}|${firstIeNm.slice(0,20)}`
  - [x] 120ms 폴링 간격
  - [x] 연속 2회 동일 stamp → return
  - [x] 타임아웃 시 throw 없음 (그냥 return)
- [x] `waitReasonInputReady(maxWait=5000)` 함수 추가
  - [x] nexacro.getPopupFrames()에서 dwldRsnPopup 확인
  - [x] 120ms 폴링 간격
  - [x] 타임아웃 시 throw 없음
- [x] runBatch() sleep 교체
  - [x] L242 `sleep(1000)` 제거 (goBack 후)
  - [x] L247 `sleep(3000)` → `waitSearchSettled(10000)`
  - [x] L259 `sleep(1000)` 제거 (enterOrg 후)
  - [x] L272 `sleep(2000)` → `waitReasonInputReady(5000)`
  - [x] L276-278 `sleep(500)×60` → `sleep(200)×150`
  - [x] L280 `sleep(500)` 제거

### 검증
- [x] throw 없는지 확인
- [x] NOFORM/ERR 시 stableTicks 리셋 확인
- [x] v1.0.3 검색→매칭→진입→다운로드→rename 흐름 유지 확인

### 리뷰
- [ ] 자체 리뷰
- [ ] Codex/Gemini 리뷰 (Phase 1~2 묶어서)

---

## Phase 2: WSL 경로 변환

### 코드 작성
- [x] state에 `cdpDownloadPath: ''` 필드 추가
- [x] `/api/set-download-dir`에서 `/mnt/c/` → `C:\` 변환
- [x] CDP `downloadPath`에 `state.cdpDownloadPath || state.downloadDir`

### 검증
- [x] `/mnt/c/projects/test` → `C:\projects\test` 확인
- [x] 비-WSL 경로 통과 확인
- [x] state.downloadDir 리눅스 경로 유지 확인

---

## Phase 3: 세션 Keep-Alive

### 코드 작성
- [x] 글로벌: `KEEPALIVE_INTERVAL_MS`, `_keepAliveTimer`, `_keepAliveFailCount`
- [x] state에 `sessionOk: true`, `alert: null` 추가
- [x] `startKeepAlive()` 함수
- [x] `stopKeepAlive()` 함수
- [x] `doKeepAlive()` 함수
  - [x] 상단 120px 버튼 탐색 (연장|유지|갱신|HH:MM)
  - [x] 확인 모달 leaf-node 닫기
  - [x] exTime 쿠키 갱신
  - [x] running && !paused 시 스킵
  - [x] 3회 연속 실패 시 alert
- [x] `/api/browser/launch`에서 startKeepAlive()
- [x] `/api/stop`에서 stopKeepAlive()

### 검증
- [x] 배치 중 doKeepAlive 스킵 확인
- [x] leaf-node 조건 확인 (childElementCount === 0)

### 리뷰
- [ ] 자체 리뷰
- [ ] Codex/Gemini 리뷰 (Phase 3~4 묶어서)

---

## Phase 4: 로그인/OTP 감지

### 코드 작성
- [x] state에 `loginOk: false`, `paused: false` 추가
- [x] `checkLoginState()` 함수
- [x] `checkOtpModal()` 함수
- [x] `/api/browser/launch` 응답에 loginOk
- [x] `/api/start`에서 로그인 확인

### 검증
- [x] nexacro 없는 페이지에서 에러 안 남 (catch)
- [x] 로그인 안 됐으면 start 거부

---

## Phase 5: 자동 네비게이션

### 코드 작성
- [x] `waitUntil(condFn, opts)` 함수
- [x] `navigateToSangsijumgum()` 함수
  - [x] ezbaro 탭 찾기
  - [x] 없으면 goto ezbaro
  - [x] fnCalMenuMove 호출
  - [x] cal00201 대기
  - [x] 'need_login' 분기
- [x] `POST /api/navigate` 엔드포인트
- [x] v1.0.3 버그 수정: L147 ezbaro 우선 매칭

### 검증
- [x] 이미 cal00201이면 true 즉시 반환
- [x] frames.length === 0 → 'need_login'

### 리뷰
- [ ] 자체 리뷰
- [ ] Codex/Gemini 리뷰 (Phase 5~6 묶어서)

---

## Phase 6: 재시도 (3라운드)

### 코드 작성
- [x] `MAX_RETRY_ROUNDS`, `PERMANENT_FAILURES`, `_startLock`
- [x] state에 `retryRound`, `mergedFile`, `_stoppedManually`
- [x] `isRetryable(reason)` 함수
- [x] `runBatchWithRetry()` 함수
- [x] `runBatch(indices)` 시그니처 변경
- [x] `/api/start` 수정
- [x] `POST /api/retry-failed` 엔드포인트

### 검증
- [x] round 0: 대기+실패(retryable) 포함
- [x] PERMANENT_FAILURES 재시도 안 함
- [x] 수동 중단 시 병합 안 함
- [x] _startLock 모든 실패 경로에서 해제

---

## Phase 7: 일시정지/재개

### 코드 작성
- [x] `POST /api/pause`
- [x] runBatch 루프 내 일시정지 체크
- [x] OTP → 자동 일시정지 + alert
- [x] `POST /api/dismiss-alert`

### 검증
- [x] 일시정지 중 다음 건 안 넘어감
- [x] stop 시 paused도 false

### 리뷰
- [ ] 자체 리뷰
- [ ] Codex/Gemini 리뷰 (Phase 7~9 묶어서)

---

## Phase 8: 병합 + 정리

### 코드 작성
- [x] `mergeDownloadedFiles(dir, results)`
- [x] `cleanupCrdownloads(dir)`
- [x] `findNewestXlsx(dir, sinceMs=0)` 개선

### 검증
- [x] 빈 결과 → null
- [x] 컬럼 수 다른 파일 skip
- [x] sinceMs 이후 파일만 대상

---

## Phase 9: runBatch 안정성

### 코드 작성
- [x] CDP 세션 detach + 재생성
- [x] 브라우저 끊김 감지 + alert
- [x] ezbaro 페이지 재선택
- [x] downloadStartTime 추적

### 검증
- [x] removeAllListeners 호출 확인
- [x] 끊김 시 running=false + alert

---

## Phase 10: /api/state 응답 확장

- [x] paused, retryRound, sessionOk, loginOk, alert, mergedFile 추가
- [x] 기존 필드 유지 확인

---

## Phase 11: web/index.html

### CSS
- [x] .status-dot.warning
- [x] .alert-banner, .alert-warning, .alert-error
- [x] .badge-retry, .badge-paused
- [x] .session-indicator

### HTML
- [x] 로그인 상태 텍스트
- [x] 세션 인디케이터
- [x] 자동 이동 버튼
- [x] 경고 배너 + 닫기
- [x] 일시정지 버튼
- [x] 실패분 재시도 버튼

### JS
- [x] autoNavigate()
- [x] togglePause()
- [x] retryFailed()
- [x] dismissAlert()
- [x] showAlert(), hideAlert()
- [x] notifyBatchDone() (Web Audio + Notification)
- [x] pollState() 확장
- [x] isPolling anti-overlap
- [x] Notification.requestPermission()
- [x] AudioContext 생성
- [x] 버전 v2.1.0
- [x] 한글 파일명 수정 (latin1→utf8) — server 쪽에서 처리

### 리뷰
- [ ] 자체 리뷰
- [ ] Codex/Gemini 리뷰 (Phase 10~11 묶어서)

---

## Phase 12: package.json
- [x] version "2.0.5" → "2.1.0"

---

## Phase 13: 테스트

### 기본
- [ ] 서버 기동 (port 14040)
- [ ] 브라우저 연결 (CDP 9446)
- [ ] 샘플 업로드 (138건)
- [ ] 다운로드 폴더 설정

### 실다운로드 (5건)
- [ ] 5건 다운로드 성공
- [ ] 건당 시간 측정 기록
- [ ] rename 정상
- [ ] 병합 파일 생성

### 리뷰
- [ ] 최종 자체 리뷰
- [ ] 최종 Codex 리뷰
- [ ] 최종 Gemini 리뷰

---

## Phase 14: 빌드 & 배포
- [ ] electron-builder --win 성공
- [ ] exe 동작 확인
- [ ] Git commit
- [ ] Git push
- [ ] GitHub 릴리즈
- [ ] 배포 URL 제공
