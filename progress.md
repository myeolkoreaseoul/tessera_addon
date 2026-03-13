# Kiwi (tessera_addon) Progress

## 2026-03-12
- v1.0.0: 초기 구현 — Electron + Express + CDP 기반 이지바로 집행내역 자동 다운로드
- v1.0.1: QA 수정 — XSS 방지, GUID 기반 다운로드 추적, sanitizeFilename, 실패 사유 표시
- v1.0.2: 한글 파일명 깨짐 수정 (multer latin1→utf8)
- v1.0.3: 키위 단면 아이콘 적용
- 사용 가이드 PDF 10페이지 작성
- GitHub repo: myeolkoreaseoul/tessera_addon
- Codex + Gemini 코드 리뷰 완료, API 테스트 11/11 통과

## 2026-03-13
- v2.0.0: 대규모 개선
  - Phase 1: 동적 폴링 — 고정 sleep 6개 → 프로그레시브 백오프 폴링 (3-4배 속도 향상)
  - Phase 2: 세션 keep-alive — 3중 전략 (DOM 클릭 + exTime 쿠키 + getSession.do 헬스체크)
  - Phase 3: 로그인/OTP 감지 — 배치 전 로그인 확인, OTP 자동 일시정지
  - Phase 4: 실패 재시도 — 3라운드 자동 재시도 (영구 실패 vs 재시도 가능 분류)
  - Phase 5: 자동 네비게이션 — Nexacro API 메뉴 탐색 + fallback
  - Phase 6: 일시정지/재개 + UI — 세션 상태, 경고 배너, 재시도 라운드 표시
