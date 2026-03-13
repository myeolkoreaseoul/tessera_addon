const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// --- 설정 ---
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4분 (5분 세션 만료 전 안전마진)
const MAX_RETRY_ROUNDS = 3;

// --- 파일명 sanitize ---
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .trim();
}

// --- 상태 ---
let state = {
  downloadDir: '',
  tasks: [],
  fileName: '',
  browserConnected: false,
  running: false,
  paused: false,
  currentIdx: -1,
  results: [],
  retryRound: 0,
  sessionOk: true,
  loginOk: false,
  alert: null, // { type: 'otp'|'session'|'error', message: string }
  mergedFile: null, // 병합 완료 시 파일명
};

let browser = null;
let page = null;
let cdpSession = null;
let _keepAliveTimer = null;
let _keepAliveFailCount = 0;
let _startLock = false; // Critical #3: start/retry 동시 실행 방지

// ============================================================
// Phase 1: 동적 폴링 헬퍼
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 범용 동적 대기 — Ezbaro_Downloader 프로그레시브 백오프 패턴
 * condFn이 truthy 반환하면 즉시 리턴, maxWait 초과 시 throw
 */
async function waitUntil(condFn, { maxWait = 15000, interval = 200 } = {}) {
  const backoff = [0, 20, 50, 100, 100, 500];
  let elapsed = 0;
  for (const delay of backoff) {
    if (delay > 0) { await sleep(delay); elapsed += delay; }
    if (elapsed > maxWait) throw new Error('waitUntil 시간 초과');
    const result = await condFn();
    if (result) return result;
  }
  while (elapsed < maxWait) {
    await sleep(interval);
    elapsed += interval;
    const result = await condFn();
    if (result) return result;
  }
  throw new Error('waitUntil 시간 초과');
}

/**
 * 검색 완료 감지 — 연속 2회 동일 rowCount면 settled
 * @param {number} maxWait - 최대 대기 시간 (ms)
 * @param {number} prevKnownCount - 이전 검색의 rowCount (stale 데이터 방지용, -1이면 무시)
 */
async function waitForSearchSettled(maxWait = 10000, prevKnownCount = -1) {
  let prevCount = -1;
  let stableHits = 0;
  let searchStarted = (prevKnownCount < 0); // prevKnownCount 없으면 즉시 시작
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const count = await page.evaluate(() => {
      const frames = window._application?.gvWorkFrame?.frames;
      for (let i = 0; i < (frames?.length || 0); i++) {
        const f = frames[i]?.form?.divWork?.form;
        if (f?.name === 'cal00201') {
          return f.ds_calOrdtmChckList?.getRowCount() ?? -1;
        }
      }
      return -1;
    }).catch(() => -1);

    // 이전 검색 결과와 다른 값이 나오면 새 검색이 시작된 것
    if (!searchStarted) {
      if (count !== prevKnownCount) searchStarted = true;
      else { await sleep(120); continue; }
    }

    if (count >= 0 && count === prevCount) {
      stableHits++;
      if (stableHits >= 2) return count;
    } else {
      stableHits = 0;
    }
    prevCount = count;
    await sleep(120);
  }
  // 타임아웃이지만 마지막 count가 유효하면 그대로 진행
  if (prevCount >= 0) return prevCount;
  throw new Error('검색 결과 대기 시간 초과');
}

/**
 * 팝업 감지 — 프로그레시브 백오프
 */
async function waitForPopup(popupName, maxWait = 5000) {
  return waitUntil(async () => {
    return page.evaluate((name) => {
      const pops = typeof nexacro !== 'undefined' ? nexacro.getPopupFrames() : [];
      for (let i = pops.length - 1; i >= 0; i--) {
        if (pops[i].name === name) return true;
      }
      return false;
    }, popupName).catch(() => false);
  }, { maxWait, interval: 150 });
}

// ============================================================
// Phase 2: 세션 Keep-Alive
// ============================================================

function startKeepAlive() {
  stopKeepAlive();
  _keepAliveFailCount = 0;
  _keepAliveTimer = setInterval(() => doKeepAlive(), KEEPALIVE_INTERVAL_MS);
  doKeepAlive(); // 즉시 1회 실행
}

function stopKeepAlive() {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
}

async function doKeepAlive() {
  if (!page) return;
  // Critical #2: 배치 실행 중이고 일시정지가 아니면 keep-alive 스킵 (page.evaluate 충돌 방지)
  if (state.running && !state.paused) return;
  try {
    // Primary: DOM 세션연장 버튼 탐색 + 클릭
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('img, button, div, span, a')].filter(el => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (r.y > 120) return false;
        const txt = (el.innerText || '').trim();
        const cls = String(el.className || '');
        return /session|timer|refresh|remain|left/i.test(cls) ||
          /연장|유지|갱신/.test(txt) ||
          /^\d{2}:\d{2}$/.test(txt);
      });
      if (candidates.length) {
        candidates[candidates.length - 1].click();
        return true;
      }
      return false;
    }).catch(() => false);

    // 확인 모달 자동 닫기
    if (clicked) {
      await sleep(1000);
      await page.evaluate(() => {
        const modal = document.querySelector('.popupMask.on, .popup_wrap.on, [class*="modal"][style*="display: block"]');
        if (modal) {
          const ok = modal.querySelector('button.fn.ok, .fn.ok, footer button, button[class*="confirm"], button[class*="ok"]');
          if (ok) ok.click();
        }
      }).catch(() => {});
    }

    // Secondary: exTime 쿠키 갱신
    try {
      const url = page.url();
      const domain = new URL(url).hostname;
      await page.context().addCookies([{
        name: 'exTime',
        value: String(Date.now() + 60 * 60 * 1000),
        domain,
        path: '/',
      }]);
    } catch {}

    if (clicked) {
      _keepAliveFailCount = 0;
      state.sessionOk = true;
    } else {
      _keepAliveFailCount++;
      if (_keepAliveFailCount >= 3) {
        state.alert = { type: 'session', message: '세션 연장 버튼을 찾지 못했습니다. 브라우저를 확인하세요.' };
      }
    }
  } catch (e) {
    _keepAliveFailCount++;
    console.error('keep-alive 오류:', e.message);
  }
}

/**
 * 세션 헬스체크 — getSession.do 호출 + ErrorCode 확인
 */
async function checkSessionHealth() {
  try {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/usr/getSession.do', { credentials: 'include' });
        const text = await res.text();
        const match = text.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
        return { ok: match ? match[1] === '0' : true, raw: text.substring(0, 200) };
      } catch { return { ok: true }; }
    }).catch(() => ({ ok: true }));
    state.sessionOk = result.ok;
    return result.ok;
  } catch { return true; }
}

// ============================================================
// Phase 3: 로그인/OTP 감지
// ============================================================

async function checkLoginState() {
  try {
    return page.evaluate(() => {
      // Nexacro 앱 로드 여부
      if (!window._application) return false;
      // 로그아웃 버튼 존재 = 로그인됨
      const body = document.body.innerText || '';
      if (/로그아웃/.test(body)) return true;
      // 로그인 버튼만 있으면 미로그인
      if (/로그인/.test(body) && !/로그아웃/.test(body)) return false;
      // Nexacro 앱이 있으면 기본적으로 로그인 상태
      return true;
    }).catch(() => false);
  } catch { return false; }
}

async function checkOtpModal() {
  try {
    return page.evaluate(() => {
      // Nexacro 팝업 중 OTP 관련 탐색
      if (typeof nexacro !== 'undefined') {
        const pops = nexacro.getPopupFrames();
        for (const p of pops) {
          const txt = p.form?.toString?.() || p.name || '';
          if (/otp|인증번호|보안문자|2차인증/i.test(txt)) return true;
        }
      }
      // DOM에서 OTP 모달 탐색
      const modals = document.querySelectorAll('[class*="popup"], [class*="modal"], [class*="layer"]');
      for (const m of modals) {
        if (m.offsetHeight > 0 && /otp|인증번호|보안문자/i.test(m.innerText)) return true;
      }
      return false;
    }).catch(() => false);
  } catch { return false; }
}

// ============================================================
// Phase 5: 자동 네비게이션
// ============================================================

async function navigateToSangsijumgum() {
  // 이미 cal00201이면 패스
  const already = await page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    for (let i = 0; i < (frames?.length || 0); i++) {
      if (frames[i]?.form?.divWork?.form?.name === 'cal00201') return true;
    }
    return false;
  }).catch(() => false);
  if (already) return true;

  // fnCalMenuMove로 정산 > 상시점검 > 상시점검 관리 이동
  const opened = await page.evaluate(() => {
    try {
      const app = window._application;
      if (!app) return false;
      const form = app.gvLeftFrame?.form;
      if (!form || typeof form.fnCalMenuMove !== 'function') return false;
      form.fnCalMenuMove('MCAL010200', 'MCAL010203');
      return true;
    } catch { return false; }
  }).catch(() => false);

  if (opened) {
    // cal00201 폼 로드 대기
    try {
      await waitUntil(async () => {
        return page.evaluate(() => {
          const frames = window._application?.gvWorkFrame?.frames;
          for (let i = 0; i < (frames?.length || 0); i++) {
            if (frames[i]?.form?.divWork?.form?.name === 'cal00201') return true;
          }
          return false;
        }).catch(() => false);
      }, { maxWait: 10000 });
      return true;
    } catch {}
  }

  // 실패 시 false 반환 — UI에서 수동 안내
  return false;
}

// ============================================================
// API 엔드포인트
// ============================================================

app.get('/api/state', (req, res) => {
  res.json({
    downloadDir: state.downloadDir,
    fileName: state.fileName,
    taskCount: state.tasks.length,
    tasks: state.tasks.map((t, i) => ({
      idx: i,
      사업년도: t.사업년도,
      과제번호: t.과제번호,
      연구수행기관: t.연구수행기관,
      연구책임자: t.연구책임자,
      status: state.results[i]?.status || '대기',
      reason: state.results[i]?.reason || '',
    })),
    browserConnected: state.browserConnected,
    running: state.running,
    paused: state.paused,
    currentIdx: state.currentIdx,
    retryRound: state.retryRound,
    sessionOk: state.sessionOk,
    loginOk: state.loginOk,
    alert: state.alert,
    mergedFile: state.mergedFile,
  });
});

app.post('/api/set-download-dir', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: '폴더 경로 필요' });
  const resolved = path.resolve(dir);
  state.downloadDir = resolved;
  try { fs.mkdirSync(resolved, { recursive: true }); } catch {}
  res.json({ ok: true, dir: resolved });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  try {
    const wb = XLSX.read(req.file.buffer);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const tasks = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[3]) continue;
      tasks.push({
        사업년도: String(r[2] || ''),
        과제번호: String(r[3] || ''),
        연구수행기관: String(r[16] || ''),
        연구책임자: String(r[19] || ''),
      });
    }
    state.tasks = tasks;
    state.results = tasks.map(() => ({ status: '대기' }));
    state.fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    res.json({ ok: true, count: tasks.length, fileName: state.fileName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/browser/launch', async (req, res) => {
  try {
    if (browser && browser.isConnected()) {
      state.browserConnected = true;
      state.loginOk = await checkLoginState();
      return res.json({ ok: true, status: 'already_connected', loginOk: state.loginOk });
    }

    const execPath = findChromePath();
    let alreadyRunning = false;
    try {
      const http = require('http');
      await new Promise((resolve, reject) => {
        const r = http.get('http://127.0.0.1:9446/json/version', { timeout: 2000 }, () => resolve(true));
        r.on('error', () => reject());
        r.on('timeout', () => { r.destroy(); reject(); });
      });
      alreadyRunning = true;
    } catch {}

    if (!alreadyRunning) {
      const dataDir = path.join(require('os').homedir(), 'kiwi-chrome-data');
      const { spawn } = require('child_process');
      const child = spawn(execPath, [
        '--remote-debugging-port=9446',
        `--user-data-dir=${dataDir}`,
        'https://www.gaia.go.kr/main.do',
      ], { detached: true, stdio: 'ignore' });
      child.unref();

      for (let i = 0; i < 20; i++) {
        await sleep(500);
        try {
          const http = require('http');
          await new Promise((resolve, reject) => {
            const r = http.get('http://127.0.0.1:9446/json/version', { timeout: 1000 }, () => resolve(true));
            r.on('error', () => reject());
            r.on('timeout', () => { r.destroy(); reject(); });
          });
          break;
        } catch {}
      }
    }

    browser = await chromium.connectOverCDP('http://127.0.0.1:9446');
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error('Chrome 컨텍스트 없음');
    const ctx = contexts[0];
    const pages = ctx.pages();
    page = pages.find(p => /gaia|ezbaro/i.test(p.url())) || pages[0];
    if (!page) throw new Error('열린 탭 없음');
    page.on('dialog', async d => { try { await d.accept(); } catch {} });

    state.browserConnected = true;
    state.loginOk = await checkLoginState();

    // 세션 keep-alive 시작
    startKeepAlive();

    res.json({ ok: true, status: alreadyRunning ? 'reconnected' : 'launched', url: page.url(), loginOk: state.loginOk });
  } catch (e) {
    state.browserConnected = false;
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/browser/status', async (req, res) => {
  const connected = !!(browser && browser.isConnected());
  state.browserConnected = connected;
  if (connected && page) {
    state.loginOk = await checkLoginState();
  }
  res.json({ connected, url: page ? page.url() : null, loginOk: state.loginOk });
});

app.post('/api/start', async (req, res) => {
  if (state.running || _startLock) return res.status(400).json({ error: '이미 실행 중' });
  _startLock = true;
  // Codex P2a: 모든 실패 경로에서 lock 해제
  if (!state.tasks.length) { _startLock = false; return res.status(400).json({ error: '과제 목록 없음' }); }
  if (!state.downloadDir) { _startLock = false; return res.status(400).json({ error: '저장 폴더 미설정' }); }
  if (!browser || !browser.isConnected()) { _startLock = false; return res.status(400).json({ error: '브라우저 미연결' }); }

  // 로그인 확인
  const loggedIn = await checkLoginState();
  if (!loggedIn) {
    _startLock = false;
    return res.status(400).json({ error: '이지바로 로그인이 필요합니다. 브라우저에서 로그인 후 다시 시도하세요.' });
  }

  state.running = true;
  state.paused = false;
  state.currentIdx = 0;
  state.retryRound = 0;
  state.alert = null;
  state.mergedFile = null;
  state._stoppedManually = false;
  _startLock = false;
  res.json({ ok: true });

  runBatchWithRetry().catch(e => {
    console.error('배치 오류:', e.message);
    state.running = false;
  });
});

app.post('/api/stop', (req, res) => {
  state.running = false;
  state.paused = false;
  state._stoppedManually = true;
  stopKeepAlive();
  res.json({ ok: true });
});

app.post('/api/pause', (req, res) => {
  state.paused = !state.paused;
  res.json({ ok: true, paused: state.paused });
});

app.post('/api/retry-failed', async (req, res) => {
  if (state.running || _startLock) return res.status(400).json({ error: '이미 실행 중' });
  _startLock = true;
  if (!browser || !browser.isConnected()) { _startLock = false; return res.status(400).json({ error: '브라우저 미연결' }); }

  const failedCount = state.results.filter(r => r.status === '실패').length;
  if (!failedCount) { _startLock = false; return res.status(400).json({ error: '실패 건 없음' }); }

  state.running = true;
  state.paused = false;
  state.retryRound = 0;
  state.alert = null;
  _startLock = false;
  res.json({ ok: true, failedCount });

  runBatchWithRetry().catch(e => {
    console.error('재시도 오류:', e.message);
    state.running = false;
  });
});

app.post('/api/navigate', async (req, res) => {
  if (!browser || !browser.isConnected()) return res.status(400).json({ error: '브라우저 미연결' });
  const ok = await navigateToSangsijumgum();
  res.json({ ok, message: ok ? '상시점검 관리 화면으로 이동 완료' : '자동 이동 실패. 수동으로 정산 → 상시점검 → 상시점검 관리로 이동하세요.' });
});

app.post('/api/dismiss-alert', (req, res) => {
  state.alert = null;
  res.json({ ok: true });
});

// ============================================================
// 핵심 로직 — Phase 4: 재시도 포함
// ============================================================

// 재시도 불가 사유
const PERMANENT_FAILURES = ['파일명이 UUID 패턴', '기관 매칭 실패'];

function isRetryable(reason) {
  return !PERMANENT_FAILURES.some(pf => reason.includes(pf));
}

async function runBatchWithRetry() {
  startKeepAlive();

  try {
    for (let round = 0; round < MAX_RETRY_ROUNDS; round++) {
      if (!state.running) break;
      state.retryRound = round;

      const indices = [];
      for (let i = 0; i < state.tasks.length; i++) {
        const r = state.results[i];
        if (round === 0 && (r.status === '대기' || (r.status === '실패' && isRetryable(r.reason || '')))) indices.push(i);
        if (round > 0 && r.status === '실패' && isRetryable(r.reason || '')) indices.push(i);
      }
      if (!indices.length) break;

      await runBatch(indices);

      // 더 이상 재시도 가능한 실패가 없으면 종료
      const retriable = state.results.filter(r => r.status === '실패' && isRetryable(r.reason || ''));
      if (!retriable.length) break;
    }
  } finally {
    const wasStopped = state._stoppedManually;
    stopKeepAlive();
    state.running = false;
    state.currentIdx = -1;

    // 수동 중단이 아닌 정상 완료 시에만 병합/정리 실행
    if (state.downloadDir && !wasStopped) {
      // .crdownload 정리 (정상 완료 시 다운로드 진행 중인 파일 없음)
      const cleaned = cleanupCrdownloads(state.downloadDir);
      if (cleaned) console.log(`${cleaned}개 .crdownload 파일 정리됨`);

      // xlsx 병합
      try {
        const mergedName = mergeDownloadedFiles(state.downloadDir, state.results);
        if (mergedName) {
          state.mergedFile = mergedName;
          console.log(`병합 파일 생성: ${mergedName}`);
        }
      } catch (e) {
        console.error('병합 실패:', e.message);
      }
    }
  }
}

async function runBatch(indices) {
  // Critical #1 + Gemini G1: 기존 CDP 세션 정리 (리스너 누적 방지)
  if (cdpSession) {
    try {
      cdpSession.removeAllListeners('Browser.downloadWillBegin');
      cdpSession.removeAllListeners('Browser.downloadProgress');
      await cdpSession.detach();
    } catch {}
  }
  cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: state.downloadDir,
    eventsEnabled: true,
  });

  let lastDownloadGuid = null;
  let lastSuggestedFilename = null;
  let downloadCompleted = false;
  let downloadStartTime = 0;

  cdpSession.on('Browser.downloadWillBegin', (params) => {
    lastDownloadGuid = params.guid;
    lastSuggestedFilename = params.suggestedFilename;
    downloadCompleted = false;
  });
  cdpSession.on('Browser.downloadProgress', (params) => {
    if (params.guid === lastDownloadGuid && params.state === 'completed') {
      downloadCompleted = true;
    }
  });

  // Major #9: 페이지 재선택 + dialog 핸들러 재등록
  const ctx = browser.contexts()[0];
  const newPage = ctx.pages().find(p => /ezbaro/i.test(p.url()));
  if (newPage && newPage !== page) {
    page = newPage;
    page.on('dialog', async d => { try { await d.accept(); } catch {} });
  }

  for (const i of indices) {
    if (!state.running) break;

    // Major #5: 브라우저 연결 끊김 감지
    if (!browser || !browser.isConnected()) {
      state.alert = { type: 'error', message: '브라우저 연결이 끊어졌습니다.' };
      state.running = false;
      break;
    }

    // Phase 6: 일시정지 체크
    while (state.paused && state.running) {
      await sleep(500);
    }
    if (!state.running) break;

    // Phase 3: OTP 감지
    if (await checkOtpModal()) {
      state.paused = true;
      state.alert = { type: 'otp', message: 'OTP 인증이 필요합니다. 브라우저에서 인증 후 재개하세요.' };
      while (state.paused && state.running) {
        await sleep(500);
      }
      if (!state.running) break;
      state.alert = null;
    }

    // Phase 2: 세션 헬스체크
    const sessionOk = await checkSessionHealth();
    if (!sessionOk) {
      state.paused = true;
      state.alert = { type: 'session', message: '세션이 만료되었습니다. 브라우저에서 재로그인 후 재개하세요.' };
      while (state.paused && state.running) {
        await sleep(500);
      }
      if (!state.running) break;
      state.alert = null;
    }

    state.currentIdx = i;
    state.results[i] = { status: '진행중' };

    const t = state.tasks[i];
    const targetName = sanitizeFilename(`${t.과제번호}_${t.연구수행기관}_${t.연구책임자}.xlsx`);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    if (uuidPattern.test(targetName)) {
      state.results[i] = { status: '실패', reason: '파일명이 UUID 패턴' };
      continue;
    }

    const targetPath = path.join(state.downloadDir, targetName);
    if (fs.existsSync(targetPath)) {
      state.results[i] = { status: '완료', reason: '이미 존재', name: targetName };
      continue;
    }

    try {
      // cal00202이면 목록 복귀
      if (await isOnCal00202()) {
        await goBackToCal00201();
        // Phase 1: sleep(1000) 제거 — goBackToCal00201 내부 폴링으로 충분
      }

      // 검색 전 현재 rowCount 캡처 (stale 결과 방지)
      const preSearchCount = await page.evaluate(() => {
        const frames = window._application?.gvWorkFrame?.frames;
        for (let i = 0; i < (frames?.length || 0); i++) {
          const f = frames[i]?.form?.divWork?.form;
          if (f?.name === 'cal00201') {
            return f.ds_calOrdtmChckList?.getRowCount() ?? -1;
          }
        }
        return -1;
      }).catch(() => -1);
      await searchTask(t.과제번호, t.사업년도);
      // Phase 1: sleep(3000) → 동적 대기 (prevKnownCount로 stale 방지)
      await waitForSearchSettled(10000, preSearchCount);

      // 기관 매칭
      const rows = await getSearchResults();
      const match = rows.find(r => r.기관명 === t.연구수행기관);
      if (!match) {
        state.results[i] = { status: '실패', reason: `기관 매칭 실패 (검색결과 ${rows.length}건)` };
        continue;
      }

      // 진입
      await enterOrg(match.row);
      // Phase 1: sleep(1000) 제거 — enterOrg 내부 폴링으로 충분

      // 기존 다운로드 파일 삭제
      const datedFile = getDatedFilename();
      const datedPath = path.join(state.downloadDir, datedFile);
      try { fs.unlinkSync(datedPath); } catch {}

      // 엑셀 다운로드
      lastDownloadGuid = null;
      lastSuggestedFilename = null;
      downloadCompleted = false;
      downloadStartTime = Date.now();

      await clickExcelDownload();
      // Phase 1: sleep(2000) → 팝업 감지 폴링
      try {
        await waitForPopup('dwldRsnPopup', 5000);
      } catch {
        // 팝업이 안 뜨면 한번 더 시도
        await sleep(500);
      }
      await fillDownloadReason();

      // 다운로드 완료 대기 (최대 30초, Phase 1: 폴링 간격 500→100ms)
      for (let w = 0; w < 300; w++) {
        if (downloadCompleted) break;
        await sleep(100);
      }
      // Phase 1: sleep(500) 제거 — downloadCompleted가 확정적 신호

      // rename
      const origFile = lastSuggestedFilename || datedFile;
      const origPath = path.join(state.downloadDir, origFile);

      if (fs.existsSync(origPath)) {
        try {
          fs.renameSync(origPath, targetPath);
          state.results[i] = { status: '완료', name: targetName };
        } catch (e) {
          state.results[i] = { status: '실패', reason: `rename 실패: ${e.message}` };
        }
      } else if (downloadCompleted) {
        const found = findNewestXlsx(state.downloadDir, downloadStartTime);
        if (found) {
          try {
            fs.renameSync(path.join(state.downloadDir, found), targetPath);
            state.results[i] = { status: '완료', name: targetName };
          } catch (e) {
            state.results[i] = { status: '실패', reason: `rename 실패: ${e.message}` };
          }
        } else {
          state.results[i] = { status: '실패', reason: '다운로드 완료됐으나 파일 없음' };
        }
      } else {
        state.results[i] = { status: '실패', reason: '다운로드 시간 초과' };
      }
    } catch (e) {
      state.results[i] = { status: '실패', reason: e.message };
    }
  }
}

// ============================================================
// CDP 헬퍼
// ============================================================

async function isOnCal00202() {
  return page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    if (!frames) return false;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]?.form?.divWork?.form?.name === 'cal00202') return true;
    }
    return false;
  }).catch(() => false);
}

async function goBackToCal00201() {
  await page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]?.form?.divWork?.form;
      if (f?.name === 'cal00202') { f.btnList_onclick(f.btnList, {}); return; }
    }
  }).catch(() => {});
  // 동적 폴링 (기존 500ms 간격 유지 — 이 부분은 페이지 전환이라 빠른 폴링 불필요)
  for (let w = 0; w < 40; w++) {
    const ok = await page.evaluate(() => {
      const frames = window._application?.gvWorkFrame?.frames;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i]?.form?.divWork?.form?.name === 'cal00201') return true;
      }
      return false;
    }).catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('cal00201 복귀 시간 초과');
}

async function searchTask(taskNo, year) {
  const ok = await page.evaluate((opts) => {
    const { task, year } = opts;
    const frames = window._application?.gvWorkFrame?.frames;
    let form = null;
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i]?.form?.divWork?.form;
      if (c?.name === 'cal00201') { form = c; break; }
    }
    if (!form) return false;
    const s = form.divSearch.form;
    try { s.chkOrdtmChckReprtCrtBjF.set_value('0'); } catch {}
    try { s.edtIeNm.set_value(''); s.edtIeNm.set_text(''); } catch {}
    try { s.edtTakNm.set_value(''); s.edtTakNm.set_text(''); } catch {}
    try { s.edtRseRspnber.set_value(''); s.edtRseRspnber.set_text(''); } catch {}
    try { s.edtEtpCd.set_value(''); s.edtEtpCd.set_text(''); } catch {}
    try { s.edtAccnutIeNm.set_value(''); s.edtAccnutIeNm.set_text(''); } catch {}
    try { s.cboTakSuCd.set_index(0); } catch {}
    try { s.cboTakCzCd.set_index(0); } catch {}
    try { s.cboSupl.set_index(0); } catch {}
    try { s.spinEtpStYs.set_value(year); } catch {}
    try { s.spinEtpEdYs.set_value(year); } catch {}
    s.edtNewTakN.set_value(task);
    s.edtNewTakN.set_text(task);
    form.divSearch_btnSearch_onclick(s.btnSearch, {});
    return true;
  }, { task: taskNo, year }).catch(() => false);
  if (!ok) throw new Error('cal00201 검색 폼 접근 실패');
}

async function getSearchResults() {
  return page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    let form = null;
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i]?.form?.divWork?.form;
      if (c?.name === 'cal00201') { form = c; break; }
    }
    if (!form) return [];
    const ds = form.ds_calOrdtmChckList;
    let rows = [];
    for (let r = 0; r < ds.getRowCount(); r++) {
      rows.push({ row: r, 기관명: ds.getColumn(r, 'ieNm') });
    }
    return rows;
  }).catch(() => []);
}

async function enterOrg(rowIdx) {
  await page.evaluate((idx) => {
    const frames = window._application?.gvWorkFrame?.frames;
    let form = null;
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i]?.form?.divWork?.form;
      if (c?.name === 'cal00201') { form = c; break; }
    }
    if (!form) return;
    form.ds_calOrdtmChckList.set_rowposition(idx);
    form.calOrdtmChckGrid_oncelldblclick(form.calOrdtmChckGrid || {}, { row: idx });
  }, rowIdx).catch(() => {});

  for (let w = 0; w < 40; w++) {
    if (await isOnCal00202()) return;
    await sleep(500);
  }
  throw new Error('cal00202 진입 시간 초과');
}

async function clickExcelDownload() {
  const ok = await page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    let form = null;
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i]?.form?.divWork?.form;
      if (c?.name === 'cal00202') { form = c; break; }
    }
    if (!form) return false;
    form.btnExcelDownload_onclick(form.btnExcelDownload, {});
    return true;
  }).catch(() => false);
  if (!ok) throw new Error('엑셀다운로드 버튼 클릭 실패');
}

async function fillDownloadReason() {
  await page.evaluate(() => {
    const pops = nexacro.getPopupFrames();
    for (let i = pops.length - 1; i >= 0; i--) {
      if (pops[i].name === 'dwldRsnPopup') {
        pops[i].form.txtRsn.set_value('집행내역 검토');
        pops[i].form.txtRsn.set_text('집행내역 검토');
        pops[i].form.btnOk_onclick(pops[i].form.btnOk, {});
        return;
      }
    }
  }).catch(() => {});
}

// ============================================================
// 파일 헬퍼
// ============================================================

function getDatedFilename() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `${ymd}_calOrdtmChckExeExcelList.xlsx`;
}

function findNewestXlsx(dir, sinceMs = 0) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~'));
    if (!files.length) return null;
    let newest = null;
    let newestTime = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(dir, f));
      // Major #4: sinceMs 이후에 생성된 파일만 대상
      if (sinceMs > 0 && stat.mtimeMs < sinceMs) continue;
      if (stat.mtimeMs > newestTime) { newestTime = stat.mtimeMs; newest = f; }
    }
    return newest;
  } catch { return null; }
}

/**
 * 완료된 다운로드 xlsx 파일들을 하나로 병합
 * 각 파일의 첫 번째 시트 데이터를 모두 이어붙임
 * 헤더는 첫 파일에서 가져오고 나머지는 데이터 행만 추가
 */
function mergeDownloadedFiles(dir, results) {
  const completedFiles = results
    .filter(r => r.status === '완료' && r.name)
    .map(r => path.join(dir, r.name))
    .filter(f => fs.existsSync(f));

  if (!completedFiles.length) return null;

  let mergedData = [];
  let header = null;

  for (const filePath of completedFiles) {
    try {
      const wb = XLSX.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (!rows.length) continue;

      if (!header) {
        header = rows[0];
        mergedData.push(header);
        mergedData.push(...rows.slice(1));
      } else {
        // 헤더 컬럼 수 불일치 시 skip
        if (rows[0] && rows[0].length !== header.length) {
          console.warn(`병합 skip (컬럼 수 불일치): ${filePath}`);
          continue;
        }
        // 헤더 행 스킵, 데이터만 추가
        mergedData.push(...rows.slice(1));
      }
    } catch (e) {
      console.error(`병합 중 파일 읽기 실패: ${filePath}`, e.message);
    }
  }

  if (mergedData.length <= 1) return null; // 헤더만 있으면 무의미

  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  let mergedName = `merged_${ymd}.xlsx`;
  let mergedPath = path.join(dir, mergedName);
  // 같은 날 재실행 시 suffix 추가
  let suffix = 1;
  while (fs.existsSync(mergedPath)) {
    suffix++;
    mergedName = `merged_${ymd}_${suffix}.xlsx`;
    mergedPath = path.join(dir, mergedName);
  }

  const newWb = XLSX.utils.book_new();
  const newWs = XLSX.utils.aoa_to_sheet(mergedData);
  XLSX.utils.book_append_sheet(newWb, newWs, '병합');
  XLSX.writeFile(newWb, mergedPath);

  return mergedName;
}

/**
 * .crdownload 임시 파일 정리
 */
function cleanupCrdownloads(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.crdownload'));
    for (const f of files) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    return files.length;
  } catch { return 0; }
}

function findChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(require('os').homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'chrome';
}

// ============================================================
// 서버 시작
// ============================================================
module.exports = {
  start(port) {
    return new Promise((resolve) => {
      app.listen(port, '127.0.0.1', () => {
        console.log(`Kiwi server on http://127.0.0.1:${port}`);
        resolve();
      });
    });
  },
};
