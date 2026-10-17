const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { chromium, firefox } = require('playwright');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');
const LOG_DIR = path.join(__dirname, 'data', 'logs');
const PROGRESS_DIR = path.join(__dirname, 'data', 'progress');

// Ensure dirs
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PROGRESS_DIR, { recursive: true });
const TASKS_DIR = path.join(__dirname, 'data', 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

// Load accounts
function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveAccounts(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Load script
const LMS_SCRIPT = fs.readFileSync(path.join(__dirname, 'lms-auto.js'), 'utf8');

// ===== Progress persistence =====
function progressKey(accountId, playUrl) {
  const m = playUrl.match(/ksb-[\d-]+/);
  const id = m ? m[0].replace(/[^a-z0-9-]/gi, '_') : require('crypto').createHash('md5').update(playUrl).digest('hex').substring(0, 12);
  return `${accountId}_${id}`;
}
function loadProgress(accountId, playUrl) {
  try {
    const f = path.join(PROGRESS_DIR, progressKey(accountId, playUrl) + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return null;
}
function saveProgress(accountId, playUrl, data) {
  const f = path.join(PROGRESS_DIR, progressKey(accountId, playUrl) + '.json');
  fs.writeFileSync(f, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2));
}
function saveTaskRecord(t) {
  try {
    const rec = { id: t.id, accountId: t.accountId, accountLabel: t.accountLabel, mode: t.mode, keyword: t.keyword, url: t.url, chapters: t.chapters, noQuiz: t.noQuiz, status: t.status, startTime: t.startTime, endTime: t.endTime, log: t.log };
    fs.writeFileSync(path.join(TASKS_DIR, t.id + '.json'), JSON.stringify(rec));
  } catch (e) {}
}
function loadTaskRecords() {
  try {
    return fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function deleteProgress(accountId, playUrl) {
  try {
    const f = path.join(PROGRESS_DIR, progressKey(accountId, playUrl) + '.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}
function listProgress() {
  try {
    return fs.readdirSync(PROGRESS_DIR).filter(f => f.endsWith('.json')).map(f => {
      const content = JSON.parse(fs.readFileSync(path.join(PROGRESS_DIR, f), 'utf8'));
      return { file: f, ...content };
    });
  } catch { return []; }
}

// ===== API =====
app.get('/api/accounts', (req, res) => {
  res.json(loadAccounts());
});

app.post('/api/accounts', (req, res) => {
  const { user, pass, label } = req.body;
  if (!user || !pass) return res.status(400).json({ error: '用户名密码必填' });
  const accounts = loadAccounts();
  const id = Date.now().toString();
  accounts.push({ id, user, pass, label: label || user, created: new Date().toISOString() });
  saveAccounts(accounts);
  res.json({ ok: true, id });
});

app.delete('/api/accounts/:id', (req, res) => {
  const accounts = loadAccounts().filter(a => a.id !== req.params.id);
  saveAccounts(accounts);
  res.json({ ok: true });
});

// Task management
const tasks = new Map(); // taskId -> { status, log, ws, browser }
// 启动时加载历史任务记录 (被重启打断的标记为 interrupted)
loadTaskRecords().forEach(rec => {
  if (rec && rec.id && !tasks.has(rec.id)) {
    if (rec.status === 'running') rec.status = 'interrupted';
    rec.ws = null; rec.browser = null;
    tasks.set(rec.id, rec);
  }
});
// 周期保存: 运行中任务每20秒快照日志, 状态变化即存
setInterval(function() {
  tasks.forEach(function(t) {
    if (t.status === 'running' || t.__savedStatus !== t.status) { saveTaskRecord(t); t.__savedStatus = t.status; }
  });
}, 20000);

app.post('/api/run', async (req, res) => {
  const { accountId, mode, keyword, url, chapters, noQuiz, noHeadless } = req.body;

  // Max 3 concurrent tasks
  var running = 0;
  tasks.forEach(function(t) { if (t.status === 'running') running++; });
  if (running >= 3) return res.status(429).json({ error: '已有 ' + running + ' 个任务在运行，最多同时跑 3 个，请等完成后再试' });
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return res.status(404).json({ error: '账号不存在' });

  const taskId = Date.now().toString();
  const task = {
    id: taskId,
    accountId,
    accountLabel: acc.label,
    mode, keyword, url, chapters, noQuiz, noHeadless,
    status: 'running',
    startTime: new Date().toISOString(),
    log: []
  };
  tasks.set(taskId, task);
  saveTaskRecord(task);
  res.json({ ok: true, taskId });

  // Run in background
  runTask(task, acc).catch(err => {
    task.log.push({ time: new Date().toISOString(), level: 'error', msg: err.message });
    task.status = 'error';
  });
});

app.get('/api/tasks', (req, res) => {
  const list = Array.from(tasks.values()).map(t => ({
    id: t.id, accountLabel: t.accountLabel, status: t.status,
    startTime: t.startTime, endTime: t.endTime,
    mode: t.mode, keyword: t.keyword, url: t.url,
    logLines: t.log.length
  }));
  res.json(list);
});

app.get('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json({
    id: t.id, accountLabel: t.accountLabel, status: t.status,
    startTime: t.startTime, endTime: t.endTime,
    mode: t.mode, keyword: t.keyword, url: t.url,
    log: t.log
  });
});

app.post('/api/tasks/:id/stop', async (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (t.browser) await t.browser.close().catch(() => {});
  t.status = 'stopped';
  t.endTime = new Date().toISOString();
  res.json({ ok: true });
});

// Progress API
app.get('/api/progress', (req, res) => {
  res.json(listProgress());
});

app.delete('/api/progress/:id', (req, res) => {
  try {
    const f = path.join(PROGRESS_DIR, req.params.id);
    if (fs.existsSync(f)) { fs.unlinkSync(f); res.json({ ok: true }); }
    else res.status(404).json({ error: '进度文件不存在' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== WebSocket for live logs =====
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const taskId = url.searchParams.get('taskId');
  if (!taskId) return ws.close();

  const t = tasks.get(taskId);
  if (!t) return ws.close();

  // Send existing logs
  ws.send(JSON.stringify({ type: 'init', log: t.log, status: t.status }));

  // Hook for new logs
  const origPush = t.log.push.bind(t.log);
  t.log.push = (entry) => {
    origPush(entry);
    ws.send(JSON.stringify({ type: 'log', entry }));
    return t.log.length;
  };

  // Status changes
  const origStatus = Object.getOwnPropertyDescriptor(t, 'status');
  let currentStatus = t.status;
  Object.defineProperty(t, 'status', {
    get() { return currentStatus; },
    set(v) {
      currentStatus = v;
      ws.send(JSON.stringify({ type: 'status', status: v }));
    }
  });

  ws.on('close', () => {
    t.log.push = origPush;
  });
});

// ===== Run task (adapted from lms-auto.js) =====
async function runTask(task, acc) {
  const log = (msg, level = 'info') => {
    const entry = { time: new Date().toISOString(), level, msg };
    task.log.push(entry);
  };

  const headless = !task.noHeadless;
  const browser = await firefox.launch({
    headless,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  task.browser = browser;

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  });
  let page = await ctx.newPage();

  // 新版企学宝: 详情页点"开始学习"后, 播放页在新标签页打开(#/course/play/), 需切换过去
  async function openPlayPage() {
    const prevUrl = page.url();
    const newPagePromise = ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null);
    let clicked = false;
    const joinBtn = await page.$('button.join');
    if (joinBtn) {
      log('[课程] 点击: 立即学习');
      await joinBtn.click().catch(() => {});
      clicked = true;
    } else {
      for (const btnText of ['开始学习', '立即学习', '继续学习', '进入学习']) {
        try {
          const btnLoc = page.locator(`button:has-text("${btnText}")`).first();
          if (await btnLoc.count() > 0 && await btnLoc.isVisible()) {
            log(`[课程] 点击: ${btnText}`);
            await btnLoc.click();
            clicked = true;
            break;
          }
        } catch {}
      }
    }
    if (!clicked) return { switched: false, locked: null };
    let np = await newPagePromise;
    const deadline = Date.now() + 15000;
    while (!np && Date.now() < deadline) {
      if (page.url() !== prevUrl && page.url().includes('/course/play/')) { np = page; break; }
      await page.waitForTimeout(500);
    }
    let switched = false;
    if (np && np !== page) {
      await np.waitForLoadState('domcontentloaded').catch(() => {});
      await np.waitForTimeout(4000);
      page = np;
      switched = true;
    } else if (np === page) {
      switched = page.url().includes('/course/play/');
    }
    const lockMsg = await page.evaluate(() => {
      const hit = Array.from(document.querySelectorAll('*')).find(e => e.children.length === 0 && e.offsetParent !== null && (e.innerText || '').includes('尚未开放学习'));
      return hit ? (hit.innerText || '').trim().substring(0, 100) : null;
    }).catch(() => null);
    return { switched, locked: lockMsg };
  }

  const CONFIG = {
    site: process.env.LMS_SITE || acc.site || 'https://your-lms.example.com',
    user: acc.user,
    pass: acc.pass,
    headless,
  };

  try {
    // ===== Login =====
    log('[登录] 打开登录页...');
    await page.goto(CONFIG.site, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    // 2026-10: 登录页改版, 用户名框不再有 material-input 类, 改为 el-input(placeholder 含"手机号")
    const userInput = await page.waitForSelector(
      'input[placeholder*="手机号"], input.material-input[type="text"]',
      { timeout: 20000 }
    );
    await userInput.fill(CONFIG.user);
    const passInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await passInput.fill(CONFIG.pass);
    // 勾选"我已阅读并同意《隐私政策》"(最后一个勾选框, 不勾无法登录)
    try {
      const cbs = await page.$$('.el-checkbox');
      if (cbs.length >= 2) await cbs[cbs.length - 1].click();
    } catch (e) {}
    await page.waitForTimeout(500);
    const loginBtn = await page.waitForSelector('button.login-btn', { timeout: 10000 });
    await loginBtn.click();
    await page.waitForTimeout(5000);
    if (page.url().includes('login')) throw new Error('登录失败，请检查用户名密码');
    log('[登录] ✅ 成功');

    let playUrl = task.url;
    let chapterList = task.chapters ? task.chapters.split(',').map(s => s.trim()) : null;

    // Search course
    if (task.mode === 'search' && task.keyword && !playUrl) {
      log(`[搜索] "${task.keyword}"...`);
      
      // Intercept API responses to find course ID from JSON rows
      let foundCourseId = null;
      const responseListener = async (resp) => {
        try {
          const url = resp.url();
          if (url.includes('/api/') && resp.request().method() === 'GET') {
            const body = await resp.text();
            if (!body.includes(task.keyword)) return;
            const json = JSON.parse(body);
            const rows = json?.data?.rows || json?.data?.list || [];
            for (const row of rows) {
              const name = row.activity_name || row.name || row.title || '';
              const id = row.id || row.course_id || '';
              if (name.includes(task.keyword) && id && String(id).length >= 4) {
                foundCourseId = id;
                break;
              }
            }
          }
        } catch {}
      };
      page.on('response', responseListener);

      // Navigate to search page
      const searchUrl = `${CONFIG.site}/static/admin/#/search/index?keyCode=${encodeURIComponent(task.keyword)}&type=home`;
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(5000);
      page.off('response', responseListener);

      if (foundCourseId) {
        log(`[搜索] 课程ID: ${foundCourseId}`);
        const summaryUrl = `${CONFIG.site}/static/admin/#/course/detail/summary/${foundCourseId}`;
        log(`[课程] 导航到详情页...`);
        await page.goto(summaryUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(5000);

        // 新版: 点击后播放页在新标签页打开, 等待并切换过去
        const openRes = await openPlayPage();
        if (openRes.locked) throw new Error('课程未开放: ' + openRes.locked);
        if (openRes.switched) log('[课程] 已切换到播放页标签');
        playUrl = page.url();
        log(`[课程] 播放页URL: ${playUrl}`);
        log('[课程] ✅ 已进入课程页面');
      } else {
        log('[搜索] 平台搜索无结果, 降级: 从「我的学习」和「课程目录」页查找...');
        const kwFB = task.keyword;
        const markHit = async (url, tabText) => {
          try { await page.goto(CONFIG.site + '/static/admin/' + url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) {}
          await page.waitForTimeout(6000);
          if (tabText) {
            try {
              const tab = page.locator('text=' + tabText).first();
              if (await tab.count() > 0) { await tab.click().catch(() => {}); await page.waitForTimeout(3500); }
            } catch (e) {}
          }
          return await page.evaluate((kw) => {
            const vis = (e) => e.offsetParent !== null;
            let best = null;
            Array.from(document.querySelectorAll('span,div,a,h3,h4,p,li')).forEach((e) => {
              if (!vis(e)) return;
              const txt = (e.innerText || '').replace(/\s+/g, ' ').trim();
              if (txt.length < 5) return;
              const fwd = txt.indexOf(kw) !== -1;
              const rev = kw.indexOf(txt) !== -1;
              if (!fwd && !rev) return;
              if (txt.length > kw.length + 40) return;
              if (!best || txt.length < (best.innerText || '').length) best = e;
            });
            if (!best) return false;
            document.querySelectorAll('[data-search-hit="1"]').forEach((e) => e.removeAttribute('data-search-hit'));
            best.setAttribute('data-search-hit', '1');
            return true;
          }, kwFB).catch(() => false);
        };
        let marked = await markHit('#/learning/course', null);
        if (!marked) marked = await markHit('#/learning/course', '我的必修');
        if (!marked) marked = await markHit('#/course/list', null);
        if (!marked) throw new Error('搜索无结果, 且「我的学习/课程目录」页均未找到: ' + kwFB);
        log('[搜索] ✅ 找到课程卡片');
        const prevUrlFB = page.url();
        const npPromiseFB = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
        let clickedFB = false;
        let hitLocFB = page.locator('[data-search-hit="1"]').first();
        for (let lv = 0; lv < 3 && !clickedFB; lv++) {
          await hitLocFB.click({ timeout: 5000 }).catch(() => {});
          for (let wi = 0; wi < 10; wi++) {
            await page.waitForTimeout(1000);
            if (page.url() !== prevUrlFB) { clickedFB = true; break; }
          }
          if (!clickedFB) {
            const npT = await npPromiseFB;
            if (npT) {
              for (let wi = 0; wi < 12; wi++) {
                const u = npT.url();
                if (u.includes('/course/play/') || u.includes('/course/detail/')) { clickedFB = true; break; }
                await npT.waitForTimeout(1000);
              }
              if (clickedFB) page = npT;
            }
          }
          if (!clickedFB && lv < 2) { hitLocFB = hitLocFB.locator('xpath=..'); log('[搜索] 标题未跳转, 尝试点击父级卡片'); }
        }
        if (!clickedFB) throw new Error('找到课程卡片但无法进入: ' + kwFB);
        if (page.url().includes('/course/play/')) {
          log('[搜索] ✅ 已直达播放页');
        } else if (page.url().includes('/course/detail/')) {
          const openResFB = await openPlayPage();
          if (openResFB.locked) throw new Error('课程未开放: ' + openResFB.locked);
          if (openResFB.switched) log('[课程] 已切换到播放页标签');
        } else {
          throw new Error('进入课程后落在未知页面: ' + page.url());
        }
        playUrl = page.url();
        const amFB = playUrl.match(/aid=([\w-]+)/);
        if (amFB) foundCourseId = amFB[1];
        log('[搜索] 课程ID: ' + (foundCourseId || '(无)'));
        log('[课程] 播放页URL: ' + playUrl);
      }
    }

    // List courses
    if (task.mode === 'list') {
      log('[课程列表]');
      const courses = await page.$$eval('[class*="list-item"]', els =>
        els.filter(e => e.offsetParent !== null).map(e => e.innerText.trim().substring(0, 80)).filter(e => e.length > 0)
      );
      courses.forEach((c, i) => log(`  ${i + 1}. ${c}`));
      task.status = 'done';
      task.endTime = new Date().toISOString();
      await browser.close();
      return;
    }

    if (!playUrl) {
      log('未提供播放页URL或搜索未找到课程', 'error');
      task.status = 'error';
      task.endTime = new Date().toISOString();
      await browser.close();
      return;
    }

    // Enter play page (已在新标签播放页内则无需再跳转)
    if (!page.url().includes('/course/play/')) {
      log('[播放] 进入播放页...');
      await page.goto(playUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(5000);
      if (page.url().includes('/summary/')) {
        // 给的是详情页URL时, 点击开始学习进入真正的播放页
        const res2 = await openPlayPage();
        if (res2.locked) throw new Error('课程未开放: ' + res2.locked);
        if (res2.switched) log('[课程] 已切换到播放页标签');
      }
    }

    // Detect chapters (新版播放页章节列表为左侧菜单 li.item, 每项以"任务N："开头)
    if (!chapterList) {
      chapterList = await page.evaluate(() => {
        const firstLine = e => (e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
        let items = Array.from(document.querySelectorAll('li.item'))
          .map(firstLine)
          .filter(t => t && /^任务/.test(t) && !t.includes('测验'));
        if (!items.length) {
          const els = document.querySelectorAll('[class*="item"], [class*="task"], [class*="node-item"]');
          items = Array.from(els)
            .filter(e => e.offsetParent !== null && (e.innerText || '').trim().match(/^任务/) && !(e.innerText || '').includes('测验'))
            .map(e => (e.innerText || '').trim().split('\n')[0].substring(0, 60));
        }
        return items.map(t => t.substring(0, 60));
      });
      log(`[播放] 检测到 ${chapterList.length} 个视频章节`);
      if (chapterList.length === 0) throw new Error('未检测到任何章节（课程可能未开放，或进入了错误页面）');
    } else {
      log(`[播放] 指定 ${chapterList.length} 个章节`);
    }
    chapterList.forEach((ch, i) => log(`  ${i + 1}. ${ch}`));

    const videoChapters = chapterList.filter(ch => !ch.includes('测验') && !ch.includes('考试'));

    // findVideo helper
    async function findVideo() {
      try { const v = await page.$('video'); if (v) return v; } catch {}
      for (const cf of page.mainFrame().childFrames()) {
        try { const v = await cf.$('video'); if (v) return v; } catch {}
      }
      return null;
    }

    // Close any popup: video.js error display, Element UI dialog, etc.
    async function closeErrorDialog() {
      try {
        await page.evaluate(() => {
          document.querySelectorAll('.vjs-error-display, .vjs-modal-dialog').forEach(el => {
            if (!el.classList.contains('vjs-text-track-settings')) {
              el.classList.add('vjs-hidden');
              el.style.display = 'none';
            }
          });
        });
      } catch {}
      await page.keyboard.press('Escape').catch(() => {});
      try {
        const closeBtn = page.locator('.el-message-box__close, .el-message-box__btns button').first();
        if (await closeBtn.count() > 0 && await closeBtn.isVisible()) {
          await closeBtn.click({ timeout: 2000 });
          await page.waitForTimeout(1000);
        }
      } catch {}
    }

    // Play until done
    async function playUntilDone(name) {
      await closeErrorDialog();
      let video = await findVideo();
      if (!video) { log('  等待视频加载...'); await page.waitForTimeout(3000); video = await findVideo(); }
      if (!video) {
        log(`  ⚠️ 未找到video，重试: ${name}`, 'warn');
        await closeErrorDialog();
        await page.waitForTimeout(3000);
        video = await findVideo();
      }
      if (!video) {
        log(`  📦 无video，直接模拟ended: ${name}`);
        await page.evaluate(() => {
          let v = document.querySelector('video');
          if (!v) { v = document.createElement('video'); document.body.appendChild(v); }
          v.dispatchEvent(new Event('ended'));
        });
        await page.waitForTimeout(3000);
        await closeErrorDialog();
        log(`  ✅ 已模拟完成: ${name}`);
        return true;
      }
      await video.evaluate(v => { v.muted = true; v.play(); }).catch(() => {});
      await page.waitForTimeout(2000);
      const videoState = await video.evaluate(v => ({
        duration: v.duration, readyState: v.readyState,
        networkState: v.networkState, error: v.error ? v.error.code : null
      })).catch(() => ({}));
      if (videoState.error || !videoState.duration || !isFinite(videoState.duration)) {
        log(`  📦 视频无法播放(error=${videoState.error})，模拟完成...`);
        await page.evaluate(() => {
          document.querySelectorAll('.vjs-error-display, .vjs-modal-dialog').forEach(el => {
            if (!el.classList.contains('vjs-text-track-settings')) {
              el.classList.add('vjs-hidden'); el.style.display = 'none';
            }
          });
          const v = document.querySelector('video');
          if (v) {
            try { v.currentTime = 999999; } catch {}
            v.dispatchEvent(new Event('ended'));
          }
          if (typeof window.videojs !== 'undefined') {
            document.querySelectorAll('.video-js').forEach(el => {
              try {
                const player = window.videojs(el);
                if (player && player.ended) player.ended(true);
                if (player && player.trigger) player.trigger('ended');
              } catch {}
            });
          }
        });
        await page.waitForTimeout(3000);
        await closeErrorDialog();
        log(`  ✅ 已上报完成: ${name}`);
        return true;
      }
      const duration = videoState.duration;
      log(`  📹 时长: ${Math.round(duration / 60)}分${Math.round(duration % 60)}秒`);

      let lastT = 0, stuck = 0;
      const startTime = Date.now();
      while (true) {
        await page.waitForTimeout(10000);
        const t = await video.evaluate(v => v.currentTime).catch(() => 0);
        const ended = await video.evaluate(v => v.ended).catch(() => false);
        const paused = await video.evaluate(v => v.paused).catch(() => false);
        const pct = (t / duration * 100).toFixed(1);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log(`  ⏱️  ${t.toFixed(0)}/${Math.round(duration)}s (${pct}%) | 已用${elapsed}s`);

        if (ended) { log(`  ✅ 完成: ${name}`); return true; }
        if (t < 1 && lastT > duration * 0.95) { log(`  ✅ 完成（视频重置）: ${name}`); return true; }
        if (paused) { log('  🔄 视频暂停，恢复播放...'); await video.evaluate(v => v.play()).catch(() => {}); }
        if (Math.abs(t - lastT) < 1 && !paused) {
          stuck++;
          if (stuck > 3) { log('  🔄 视频卡住，模拟完成...'); 
            await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.dispatchEvent(new Event('ended')); });
            await closeErrorDialog();
            await page.waitForTimeout(5000); return true; }
        } else { stuck = 0; lastT = t; }
      }
    }

    async function switchChapter(name) {
      await closeErrorDialog();
      try {
        const items = page.locator('li.item');
        const count = await items.count();
        for (let i = 0; i < count; i++) {
          const text = (await items.nth(i).innerText()).trim();
          if (text.includes(name)) {
            await items.nth(i).click({ timeout: 5000 });
            log(`  🔄 切换到: ${text.substring(0, 40)}`);
            await page.waitForTimeout(2000);
            await closeErrorDialog();
            await page.waitForTimeout(2000);
            // Verify switch succeeded
            const activeItem = await page.locator('li.item.active').count();
            if (activeItem > 0) {
              const activeText = (await page.locator('li.item.active').first().innerText()).trim();
              if (!activeText.includes(name)) {
                log('  🔄 重试点击章节');
                await closeErrorDialog();
                await items.nth(i).click({ timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(3000);
                await closeErrorDialog();
              }
            }
            return true;
          }
        }
      } catch (e) { log(`  ⚠️ 点击失败: ${e.message.substring(0, 40)}`); }
      log(`  ⚠️ 未找到章节: ${name}`, 'warn');
      return false;
    }

    // Read platform chapter status to find resume point
    async function getPlatformChapterStatus() {
      return await page.evaluate(function() {
        var items = document.querySelectorAll('li.item');
        var completedCount = 0;
        for (var i = 0; i < items.length; i++) {
          var icon = items[i].querySelector('.lrn-status i');
          if (icon && icon.classList.contains('el-icon-success')) { completedCount++; }
          else { break; }
        }
        return completedCount;
      }).catch(function() { return 0; });
    }

    // Check platform progress first
    var platformCompleted = await getPlatformChapterStatus();
    if (platformCompleted > 0) {
      log('[平台进度] 平台记录已完成 ' + platformCompleted + ' 章，从第 ' + (platformCompleted + 1) + ' 章继续');
    }

    // Play chapters (resume from platform progress)
    var startIdx = platformCompleted;

    // Also check local progress as fallback (for crash within video)
    var localProgress = loadProgress(acc.id, playUrl);
    if (localProgress && localProgress.videoChapters) {
      var localCompleted = new Set(localProgress.completedChapters || []);
      if (localCompleted.size > startIdx) {
        log('[本地进度] 本地记录了更多已完成章节 (' + localCompleted.size + ')，可能平台尚未同步');
        startIdx = localCompleted.size;
      }
    }

    if (startIdx >= videoChapters.length) {
      log('[进度] 所有章节已完成，跳过播放');
      deleteProgress(acc.id, playUrl);
    } else {
      var st0 = await page.evaluate(function(t) {
        var lis = document.querySelectorAll('li.item');
        var found = -1;
        for (var k = 0; k < lis.length; k++) { if ((lis[k].innerText || '').indexOf(t) !== -1) { found = k; break; } }
        if (found < 0) return 'missing';
        var ic = lis[found].querySelector('.lrn-status i');
        var cls = ic ? ic.className.toString() : '';
        if (/el-icon-success/.test(cls)) return 'success';
        if (/active/.test(cls)) {
          for (var j = found + 1; j < lis.length; j++) {
            var ic2 = lis[j].querySelector('.lrn-status i');
            if (ic2 && /el-icon-success/.test(ic2.className.toString())) return 'active-completed';
          }
        }
        return 'other';
      }, videoChapters[startIdx]).catch(function() { return 'other'; });
      var completedSet = new Set();
      if (st0 === 'success' || st0 === 'active-completed') {
        log('[播放] 第' + (startIdx + 1) + '章平台已标记完成, 跳过: ' + videoChapters[startIdx]);
      } else {
        log('[播放] 开始播放第' + (startIdx + 1) + '章: ' + videoChapters[startIdx]);
        await playUntilDone(videoChapters[startIdx]);
      }
      for (var ci = 0; ci <= startIdx; ci++) completedSet.add(videoChapters[ci]);
      saveProgress(acc.id, playUrl, { accountId: acc.id, courseUrl: playUrl, completedChapters: Array.from(completedSet), videoChapters: videoChapters });

      for (var i = startIdx + 1; i < videoChapters.length; i++) {
        if (task.status === 'stopped') { log('任务已停止，进度已保存'); break; }
        var chDone = await page.evaluate(function(t) {
          var lis = document.querySelectorAll('li.item');
          for (var k = 0; k < lis.length; k++) {
            if ((lis[k].innerText || '').indexOf(t) !== -1) {
              var ic = lis[k].querySelector('.lrn-status i');
              return !!(ic && /el-icon-success/.test(ic.className.toString()));
            }
          }
          return false;
        }, videoChapters[i]).catch(function() { return false; });
        if (chDone) { log('[播放] 第' + (i + 1) + '章平台已标记完成, 跳过: ' + videoChapters[i]); completedSet.add(videoChapters[i]); saveProgress(acc.id, playUrl, { accountId: acc.id, courseUrl: playUrl, completedChapters: Array.from(completedSet), videoChapters: videoChapters }); continue; }
        log('[播放] 切换到第' + (i + 1) + '章: ' + videoChapters[i]);
        await switchChapter(videoChapters[i]);
        await playUntilDone(videoChapters[i]);
        completedSet.add(videoChapters[i]);
        saveProgress(acc.id, playUrl, { accountId: acc.id, courseUrl: playUrl, completedChapters: Array.from(completedSet), videoChapters: videoChapters });
      }

      if (completedSet.size >= videoChapters.length) {
        deleteProgress(acc.id, playUrl);
        log('🎉 所有视频章节播放完毕！');
      }
    }

    // Quiz (exambot: 题库优先 + 成绩页收割正确答案 + 剩余次数保护栏)
    if (!task.noQuiz) {
      try {
        const aidM = page.url().match(/aid=([\w-]+)/);
        const courseId = aidM ? aidM[1] : null;
        if (!courseId) {
          log('[测验] ⚠️ 未能从URL解析课程ID, 跳过测验');
        } else {
          const exambot = require('/app/data/exambot.js');
          const er = await exambot.runExamFlow(page, courseId, { log: m => log(m), label: (task.keyword || courseId) });
          log('[测验] 结果: ' + er.status + ' 分数=' + JSON.stringify(er.scores) + ' 耗用次数=' + er.attemptsUsed + ' 题库=' + er.bankSize + '题');
        }
      } catch (qe) {
        log('[测验] 异常: ' + qe.message, 'warn');
      }
    }
    log('🎉 全部完成！');
    task.status = 'done';
    task.endTime = new Date().toISOString();
  } catch (err) {
    log('❌ 错误: ' + err.message, 'error');
    task.status = 'error';
    task.endTime = new Date().toISOString();
  } finally {
    if (task.browser) await task.browser.close().catch(() => {});
  }
}

const PORT = 8088;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`LMS Panel running on http://0.0.0.0:${PORT}`);
});
