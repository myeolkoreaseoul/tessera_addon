const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

const upload = multer({ storage: multer.memoryStorage() });

// --- 상태 ---
let state = {
  downloadDir: '',        // 저장 폴더
  tasks: [],              // 엑셀에서 파싱한 과제 목록
  fileName: '',           // 업로드된 파일명
  browserConnected: false,
  running: false,
  currentIdx: -1,
  results: [],            // { idx, status, name }
};

let browser = null;
let page = null;
let cdpSession = null;

// --- API ---

// 상태 조회
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
    })),
    browserConnected: state.browserConnected,
    running: state.running,
    currentIdx: state.currentIdx,
  });
});

// 저장 폴더 설정
app.post('/api/set-download-dir', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: '폴더 경로 필요' });
  state.downloadDir = dir;
  res.json({ ok: true, dir });
});

// 엑셀 업로드
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  try {
    const wb = XLSX.read(req.file.buffer);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const tasks = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[3]) continue; // 과제번호 없으면 스킵
      tasks.push({
        사업년도: String(r[2] || ''),
        과제번호: String(r[3] || ''),
        연구수행기관: String(r[16] || ''),
        연구책임자: String(r[19] || ''),
      });
    }
    state.tasks = tasks;
    state.results = tasks.map(() => ({ status: '대기' }));
    state.fileName = req.file.originalname;
    res.json({ ok: true, count: tasks.length, fileName: state.fileName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 브라우저 열기
app.post('/api/browser/launch', async (req, res) => {
  try {
    // 이미 연결되어 있으면 상태만 반환
    if (browser && browser.isConnected()) {
      state.browserConnected = true;
      return res.json({ ok: true, status: 'already_connected' });
    }

    // 로컬 Chrome 실행 (CDP 9446)
    const execPath = findChromePath();
    const { execSync } = require('child_process');

    // 이미 9446에서 실행 중인지 확인
    let alreadyRunning = false;
    try {
      const http = require('http');
      await new Promise((resolve, reject) => {
        const r = http.get('http://127.0.0.1:9446/json/version', { timeout: 2000 }, (resp) => {
          resolve(true);
        });
        r.on('error', () => reject());
        r.on('timeout', () => { r.destroy(); reject(); });
      });
      alreadyRunning = true;
    } catch {}

    if (!alreadyRunning) {
      const dataDir = path.join(require('os').homedir(), 'kiwi-chrome-data');
      const args = [
        `--remote-debugging-port=9446`,
        `--user-data-dir=${dataDir}`,
        'https://www.gaia.go.kr/main.do',
      ];
      const { spawn } = require('child_process');
      const child = spawn(execPath, args, { detached: true, stdio: 'ignore' });
      child.unref();
      await sleep(3000);
    }

    // CDP 연결
    browser = await chromium.connectOverCDP('http://127.0.0.1:9446');
    const contexts = browser.contexts();
    const ctx = contexts[0];
    const pages = ctx.pages();
    page = pages.find(p => /gaia|ezbaro/i.test(p.url())) || pages[0];
    page.on('dialog', async d => { try { await d.accept(); } catch {} });

    state.browserConnected = true;
    res.json({ ok: true, status: alreadyRunning ? 'reconnected' : 'launched', url: page.url() });
  } catch (e) {
    state.browserConnected = false;
    res.status(500).json({ error: e.message });
  }
});

// 브라우저 상태
app.get('/api/browser/status', (req, res) => {
  const connected = browser && browser.isConnected();
  state.browserConnected = connected;
  res.json({ connected, url: page ? page.url() : null });
});

// 다운로드 시작
app.post('/api/start', async (req, res) => {
  if (state.running) return res.status(400).json({ error: '이미 실행 중' });
  if (!state.tasks.length) return res.status(400).json({ error: '과제 목록 없음' });
  if (!state.downloadDir) return res.status(400).json({ error: '저장 폴더 미설정' });
  if (!browser || !browser.isConnected()) return res.status(400).json({ error: '브라우저 미연결' });

  state.running = true;
  state.currentIdx = 0;
  res.json({ ok: true });

  // 비동기로 실행
  runBatch().catch(e => {
    console.error('배치 오류:', e.message);
    state.running = false;
  });
});

// 중지
app.post('/api/stop', (req, res) => {
  state.running = false;
  res.json({ ok: true });
});

// --- 핵심 로직 ---

async function runBatch() {
  // setDownloadBehavior
  cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: state.downloadDir,
    eventsEnabled: true,
  });

  let downloadCompleted = false;
  cdpSession.on('Browser.downloadProgress', (params) => {
    if (params.state === 'completed') downloadCompleted = true;
  });

  // ezbaro 페이지 찾기
  const ctx = browser.contexts()[0];
  page = ctx.pages().find(p => /ezbaro/i.test(p.url())) || page;

  const DOWNLOAD_FILENAME = null; // 서버가 주는 파일명 (동적 감지)

  for (let i = 0; i < state.tasks.length; i++) {
    if (!state.running) break;
    state.currentIdx = i;
    state.results[i] = { status: '진행중' };

    const t = state.tasks[i];
    const targetName = `${t.과제번호}_${t.연구수행기관}_${t.연구책임자}.xlsx`;

    try {
      // cal00202이면 목록으로 복귀
      if (await isOnCal00202()) {
        await goBackToCal00201();
        await sleep(1000);
      }

      // 검색
      await searchTask(t.과제번호, t.사업년도);
      await sleep(3000);

      // 기관 매칭
      const rows = await getSearchResults();
      const match = rows.find(r => r.기관명 === t.연구수행기관);
      if (!match) {
        state.results[i] = { status: '실패', reason: '기관 매칭 실패' };
        continue;
      }

      // 진입
      await enterOrg(match.row);
      await sleep(1000);

      // 기존 다운로드 파일 삭제 (덮어쓰기 방지)
      await deleteFileInDir(state.downloadDir, getDatedFilename());

      // 엑셀 다운로드
      downloadCompleted = false;
      await clickExcelDownload();
      await sleep(2000);
      await fillDownloadReason();

      // 다운로드 대기
      for (let w = 0; w < 60; w++) {
        if (downloadCompleted) break;
        await sleep(500);
      }
      await sleep(500);

      // rename
      const origFile = await findDownloadedFile(state.downloadDir);
      if (origFile) {
        await renameFile(state.downloadDir, origFile, targetName);
        // UUID 방어 체크
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        if (uuidPattern.test(targetName)) {
          state.results[i] = { status: '실패', reason: 'UUID 파일명 감지' };
        } else {
          state.results[i] = { status: '완료', name: targetName };
        }
      } else {
        state.results[i] = { status: '실패', reason: '다운로드 파일 없음' };
      }
    } catch (e) {
      state.results[i] = { status: '실패', reason: e.message };
    }
  }

  state.running = false;
  state.currentIdx = -1;
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
}

async function searchTask(taskNo, year) {
  await page.evaluate((opts) => {
    const { task, year } = opts;
    const frames = window._application?.gvWorkFrame?.frames;
    let form = null;
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i]?.form?.divWork?.form;
      if (c?.name === 'cal00201') { form = c; break; }
    }
    if (!form) return;
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
  }, { task: taskNo, year }).catch(() => {});
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
  await page.evaluate(() => {
    const frames = window._application?.gvWorkFrame?.frames;
    let form = null;
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i]?.form?.divWork?.form;
      if (c?.name === 'cal00202') { form = c; break; }
    }
    if (form) form.btnExcelDownload_onclick(form.btnExcelDownload, {});
  }).catch(() => {});
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

async function findDownloadedFile(dir) {
  const fs = require('fs');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx'));
    // 가장 최근 파일
    if (files.length === 0) return null;
    let newest = files[0];
    let newestTime = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(dir, f));
      if (stat.mtimeMs > newestTime) {
        newestTime = stat.mtimeMs;
        newest = f;
      }
    }
    return newest;
  } catch {
    return null;
  }
}

async function deleteFileInDir(dir, name) {
  const fs = require('fs');
  const fp = path.join(dir, name);
  try { fs.unlinkSync(fp); } catch {}
}

async function renameFile(dir, oldName, newName) {
  const fs = require('fs');
  const oldPath = path.join(dir, oldName);
  const newPath = path.join(dir, newName);
  try { fs.renameSync(oldPath, newPath); } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function findChromePath() {
  const fs = require('fs');
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
