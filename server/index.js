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

// --- 파일명 sanitize ---
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')  // Windows 금지 문자
    .replace(/\.\./g, '_')           // 경로 탈출 방지
    .replace(/^\.+/, '_')            // 숨김 파일 방지
    .trim();
}

// --- 상태 ---
let state = {
  downloadDir: '',
  cdpDownloadPath: '',
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
  alert: null,
  mergedFile: null,
  _stoppedManually: false,
};

let browser = null;
let page = null;
let cdpSession = null;
let _keepAliveTimer = null;
let _keepAliveFailCount = 0;
let _startLock = false;

const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
const MAX_RETRY_ROUNDS = 3;
const PERMANENT_FAILURES = ['파일명이 UUID 패턴', '기관 매칭 실패'];

// --- API ---

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
    currentIdx: state.currentIdx,
    paused: state.paused,
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
  // WSL→Windows 경로 변환 (CDP는 Chrome이 실행되는 Windows 경로 필요)
  if (resolved.startsWith('/mnt/')) {
    const drive = resolved.charAt(5).toUpperCase();
    state.cdpDownloadPath = drive + ':' + resolved.substring(6).replace(/\//g, '\\');
  } else {
    state.cdpDownloadPath = resolved;
  }
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
      return res.json({ ok: true, status: 'already_connected' });
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

      // 최대 10초 대기
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
    // ezbaro 우선 매칭 (v1.0.3 버그 수정: gaia 먼저 매칭되던 문제)
    page = pages.find(p => /ezbaro/i.test(p.url()))
        || pages.find(p => /gaia/i.test(p.url()))
        || pages[0];
    if (!page) throw new Error('열린 탭 없음');
    page.on('dialog', async d => { try { await d.accept(); } catch {} });

    state.browserConnected = true;
    state.loginOk = await checkLoginState();
    startKeepAlive();
    res.json({ ok: true, status: alreadyRunning ? 'reconnected' : 'launched', url: page.url(), loginOk: state.loginOk });
  } catch (e) {
    state.browserConnected = false;
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/browser/status', (req, res) => {
  const connected = !!(browser && browser.isConnected());
  state.browserConnected = connected;
  res.json({ connected, url: page ? page.url() : null });
});

app.post('/api/start', async (req, res) => {
  if (_startLock) return res.status(400).json({ error: '이미 실행 중' });
  if (state.running) return res.status(400).json({ error: '이미 실행 중' });
  if (!state.tasks.length) return res.status(400).json({ error: '과제 목록 없음' });
  if (!state.downloadDir) return res.status(400).json({ error: '저장 폴더 미설정' });
  if (!browser || !browser.isConnected()) return res.status(400).json({ error: '브라우저 미연결' });

  const loggedIn = await checkLoginState();
  state.loginOk = loggedIn;
  if (!loggedIn) return res.status(400).json({ error: '로그인 필요' });

  _startLock = true;
  state.running = true;
  state.paused = false;
  state._stoppedManually = false;
  state.mergedFile = null;
  state.retryRound = 0;
  state.currentIdx = 0;
  res.json({ ok: true });

  runBatchWithRetry().catch(e => {
    console.error('배치 오류:', e.message);
  }).finally(() => {
    _startLock = false;
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

app.post('/api/navigate', async (req, res) => {
  if (!browser || !browser.isConnected()) return res.status(400).json({ error: '브라우저 미연결' });
  try {
    const result = await navigateToSangsijumgum();
    if (result === true) res.json({ ok: true, message: '상시점검 관리 화면으로 이동 완료' });
    else if (result === 'need_login') res.json({ ok: true, message: '이지바로 이동 완료. 로그인 후 다시 눌러주세요.' });
    else res.json({ ok: false, message: '자동 이동 실패. 수동으로 이동하세요.' });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post('/api/pause', (req, res) => {
  state.paused = !state.paused;
  res.json({ ok: true, paused: state.paused });
});

app.post('/api/retry-failed', async (req, res) => {
  if (_startLock) return res.status(400).json({ error: '이미 실행 중' });
  if (!state.tasks.length) return res.status(400).json({ error: '과제 목록 없음' });
  if (!state.downloadDir) return res.status(400).json({ error: '저장 폴더 미설정' });
  if (!browser || !browser.isConnected()) return res.status(400).json({ error: '브라우저 미연결' });

  const failedIndices = [];
  for (let i = 0; i < state.results.length; i++) {
    if (state.results[i].status === '실패' && isRetryable(state.results[i].reason || '')) {
      failedIndices.push(i);
    }
  }
  if (!failedIndices.length) return res.json({ ok: true, message: '재시도 대상 없음' });

  _startLock = true;
  state.running = true;
  state.paused = false;
  state._stoppedManually = false;
  res.json({ ok: true, retryCount: failedIndices.length });

  (async () => {
    try {
      for (const i of failedIndices) {
        state.results[i] = { status: '대기' };
      }
      await runBatch(failedIndices);
    } catch (e) {
      console.error('재시도 오류:', e.message);
    } finally {
      _startLock = false;
      state.running = false;
      state.currentIdx = -1;
    }
  })();
});

app.post('/api/dismiss-alert', (req, res) => {
  state.alert = null;
  res.json({ ok: true });
});

// --- 핵심 로직 ---

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

      const retriable = state.results.filter(r => r.status === '실패' && isRetryable(r.reason || ''));
      if (!retriable.length) break;
    }
  } finally {
    const wasStopped = state._stoppedManually;
    stopKeepAlive();
    state.running = false;
    state.currentIdx = -1;

    if (state.downloadDir && !wasStopped) {
      cleanupCrdownloads(state.downloadDir);
      try {
        const mergedName = mergeDownloadedFiles(state.downloadDir, state.results);
        if (mergedName) { state.mergedFile = mergedName; }
      } catch (e) { console.error('병합 실패:', e.message); }
    }
  }
}

async function runBatch(indices) {
  // CDP 세션 정리 + 재생성 (리스너 누적 방지)
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
    downloadPath: state.cdpDownloadPath || state.downloadDir,
    eventsEnabled: true,
  });

  // GUID 기반 다운로드 추적
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

  // ezbaro 페이지 재선택
  const ctx = browser.contexts()[0];
  const newPage = ctx.pages().find(p => /ezbaro/i.test(p.url()));
  if (newPage && newPage !== page) {
    page = newPage;
    page.on('dialog', async d => { try { await d.accept(); } catch {} });
  }

  for (const i of indices) {
    // 브라우저 연결 끊김 감지
    if (!browser || !browser.isConnected()) {
      state.alert = { type: 'error', message: '브라우저 연결 끊김' };
      state.running = false;
      break;
    }

    // 일시정지 체크
    while (state.paused && state.running) await sleep(500);
    if (!state.running) break;

    // OTP 감지 → 자동 일시정지
    if (await checkOtpModal()) {
      state.paused = true;
      state.alert = { type: 'otp', message: 'OTP 인증 필요. 브라우저에서 인증 후 재개하세요.' };
      while (state.paused && state.running) await sleep(500);
      if (!state.running) break;
      state.alert = null;
    }

    state.currentIdx = i;
    state.results[i] = { status: '진행중' };

    const t = state.tasks[i];
    const targetName = sanitizeFilename(`${t.과제번호}_${t.연구수행기관}_${t.연구책임자}.xlsx`);

    // UUID 방어
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    if (uuidPattern.test(targetName)) {
      state.results[i] = { status: '실패', reason: '파일명이 UUID 패턴' };
      continue;
    }

    // 이미 존재하면 스킵
    const targetPath = path.join(state.downloadDir, targetName);
    if (fs.existsSync(targetPath)) {
      state.results[i] = { status: '완료', reason: '이미 존재', name: targetName };
      continue;
    }

    try {
      // cal00202이면 목록 복귀
      if (await isOnCal00202()) {
        await goBackToCal00201();
      }

      // 검색
      await searchTask(t.과제번호, t.사업년도);
      await waitSearchSettled(10000);

      // 기관 매칭
      const rows = await getSearchResults();
      const match = rows.find(r => r.기관명 === t.연구수행기관);
      if (!match) {
        state.results[i] = { status: '실패', reason: `기관 매칭 실패 (검색결과 ${rows.length}건)` };
        continue;
      }

      // 진입
      await enterOrg(match.row);

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
      await waitReasonInputReady(5000);
      await fillDownloadReason();

      // 다운로드 완료 대기 (최대 30초)
      for (let w = 0; w < 150; w++) {
        if (downloadCompleted) break;
        await sleep(200);
      }

      // rename — suggestedFilename 또는 dated 파일명으로 탐색
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

// --- CDP 헬퍼 ---

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

// --- 파일 헬퍼 ---

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
      if (sinceMs && stat.mtimeMs < sinceMs) continue;
      if (stat.mtimeMs > newestTime) { newestTime = stat.mtimeMs; newest = f; }
    }
    return newest;
  } catch { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 검색 settled 감지 — Ezbaro stamp 패턴 (120ms 폴링)
 * stamp = count|firstIeNm — 연속 2회 동일 시 settled
 * 타임아웃 시 throw 안 함 (그냥 진행 — 최악=v1.0.3 수준)
 */
async function waitSearchSettled(maxWait = 10000) {
  let prevStamp = '';
  let stableTicks = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const stamp = await page.evaluate(() => {
      const frames = window._application?.gvWorkFrame?.frames;
      for (let i = 0; i < (frames?.length || 0); i++) {
        const f = frames[i]?.form?.divWork?.form;
        if (f?.name === 'cal00201') {
          const ds = f.ds_calOrdtmChckList;
          const count = ds?.getRowCount() ?? -1;
          const firstIeNm = count > 0 ? (ds.getColumn(0, 'ieNm') || '') : '';
          return `${count}|${firstIeNm.slice(0, 20)}`;
        }
      }
      return 'NOFORM';
    }).catch(() => 'ERR');

    if (stamp !== 'NOFORM' && stamp !== 'ERR' && stamp === prevStamp) {
      stableTicks++;
      if (stableTicks >= 2) return;
    } else {
      stableTicks = 0;
    }
    prevStamp = stamp;
    await sleep(120);
  }
}

/**
 * 다운로드 사유 팝업 감지 — dwldRsnPopup 출현 폴링 (120ms)
 * 타임아웃 시 throw 안 함
 */
async function waitReasonInputReady(maxWait = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const ready = await page.evaluate(() => {
      const pops = typeof nexacro !== 'undefined' ? nexacro.getPopupFrames() : [];
      for (let i = pops.length - 1; i >= 0; i--) {
        if (pops[i].name === 'dwldRsnPopup') return true;
      }
      return false;
    }).catch(() => false);
    if (ready) return;
    await sleep(120);
  }
}

// ============================================================
// 세션 Keep-Alive (Phase 3)
// ============================================================

function startKeepAlive() {
  stopKeepAlive();
  _keepAliveFailCount = 0;
  _keepAliveTimer = setInterval(() => doKeepAlive(), KEEPALIVE_INTERVAL_MS);
  doKeepAlive();
}

function stopKeepAlive() {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
}

async function doKeepAlive() {
  if (!page) return;
  if (state.running && !state.paused) return;
  try {
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('img, button, div, span, a')].filter(el => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.y > 120) return false;
        const txt = (el.innerText || '').trim();
        const cls = String(el.className || '');
        return /session|timer|refresh|remain|left/i.test(cls) ||
          /연장|유지|갱신/.test(txt) || /^\d{2}:\d{2}$/.test(txt);
      });
      if (candidates.length) { candidates[candidates.length - 1].click(); return true; }
      return false;
    }).catch(() => false);

    if (clicked) {
      await sleep(1000);
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, div, span, a')].filter(el => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.childElementCount > 0) return false;
          const t = (el.innerText || '').trim();
          return t === '확인' || t === '닫기';
        });
        btns.forEach(b => b.click());
      }).catch(() => {});
    }

    try {
      const domain = new URL(page.url()).hostname;
      await page.context().addCookies([{
        name: 'exTime', value: String(Date.now() + 60 * 60 * 1000), domain, path: '/',
      }]);
    } catch {}

    if (clicked) { _keepAliveFailCount = 0; state.sessionOk = true; }
    else {
      _keepAliveFailCount++;
      if (_keepAliveFailCount >= 3) {
        state.alert = { type: 'session', message: '세션 연장 버튼을 찾지 못했습니다.' };
      }
    }
  } catch (e) { _keepAliveFailCount++; }
}

// ============================================================
// 로그인/OTP 감지 (Phase 4)
// ============================================================

async function checkLoginState() {
  try {
    return page.evaluate(() => {
      if (!window._application) return false;
      const body = document.body.innerText || '';
      if (/로그아웃/.test(body)) return true;
      if (/로그인/.test(body) && !/로그아웃/.test(body)) return false;
      return true;
    }).catch(() => false);
  } catch { return false; }
}

async function checkOtpModal() {
  try {
    return page.evaluate(() => {
      if (typeof nexacro !== 'undefined') {
        const pops = nexacro.getPopupFrames();
        for (const p of pops) {
          const txt = p.form?.toString?.() || p.name || '';
          if (/otp|인증번호|보안문자|2차인증/i.test(txt)) return true;
        }
      }
      const modals = document.querySelectorAll('[class*="popup"], [class*="modal"], [class*="layer"]');
      for (const m of modals) {
        if (m.offsetHeight > 0 && /otp|인증번호|보안문자/i.test(m.innerText)) return true;
      }
      return false;
    }).catch(() => false);
  } catch { return false; }
}

// ============================================================
// 자동 네비게이션 (Phase 5)
// ============================================================

async function waitUntil(condFn, { maxWait = 15000, interval = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const result = await condFn();
    if (result) return result;
    await sleep(interval);
  }
  return false;
}

async function navigateToSangsijumgum() {
  if (browser && browser.isConnected()) {
    const ctx = browser.contexts()[0];
    const allPages = ctx?.pages() || [];
    let ezPage = allPages.find(p => /ezbaro/i.test(p.url()));

    if (!ezPage) {
      const targetPage = allPages.find(p => /gaia/i.test(p.url())) || page;
      if (targetPage) {
        try {
          await targetPage.goto('https://www.ezbaro.go.kr/rims/index.html',
            { waitUntil: 'domcontentloaded', timeout: 15000 });
          await waitUntil(async () => {
            return targetPage.evaluate(() =>
              typeof window._application?.gvLeftFrame?.form?.fnCalMenuMove === 'function'
            ).catch(() => false);
          }, { maxWait: 10000, interval: 500 });
          ezPage = targetPage;
          page = targetPage;
        } catch {}
      }
    }

    if (ezPage && ezPage !== page) {
      page = ezPage;
      page.on('dialog', async d => { try { await d.accept(); } catch {} });
    }
  }

  const already = await page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    for (let i = 0; i < (frames?.length || 0); i++) {
      if (frames[i]?.form?.divWork?.form?.name === 'cal00201') return true;
    }
    return false;
  }).catch(() => false);
  if (already) return true;

  const opened = await page.evaluate(() => {
    try {
      const form = window._application?.gvLeftFrame?.form;
      if (!form || typeof form.fnCalMenuMove !== 'function') return false;
      form.fnCalMenuMove('MCAL010200', 'MCAL010203');
      return true;
    } catch { return false; }
  }).catch(() => false);

  if (opened) {
    await sleep(2000);
    const framesCount = await page.evaluate(() =>
      window._application?.gvWorkFrame?.frames?.length || 0
    ).catch(() => 0);

    if (framesCount === 0) return 'need_login';

    const loaded = await waitUntil(async () => {
      return page.evaluate(() => {
        const frames = window._application?.gvWorkFrame?.frames;
        for (let i = 0; i < (frames?.length || 0); i++) {
          if (frames[i]?.form?.divWork?.form?.name === 'cal00201') return true;
        }
        return false;
      }).catch(() => false);
    }, { maxWait: 10000 });
    if (loaded) return true;
  }

  return false;
}

// ============================================================
// 재시도 헬퍼 (Phase 6)
// ============================================================

function isRetryable(reason) {
  return !PERMANENT_FAILURES.some(pf => reason.includes(pf));
}

// ============================================================
// 병합 + 정리 (Phase 8)
// ============================================================

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
        if (rows[0] && rows[0].length !== header.length) {
          console.warn(`병합 skip (컬럼 수 불일치): ${filePath}`);
          continue;
        }
        mergedData.push(...rows.slice(1));
      }
    } catch (e) {
      console.error(`병합 중 파일 읽기 실패: ${filePath}`, e.message);
    }
  }

  if (mergedData.length <= 1) return null;

  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  let mergedName = `merged_${ymd}.xlsx`;
  let mergedPath = path.join(dir, mergedName);
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

// --- 서버 시작 ---
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
