#!/usr/bin/env node
/**
 * LMS 自动刷课脚本（企学宝平台）
 * 
 * 用法：
 *   node lms-auto.js --url "播放页URL" --chapters "第1讲,第2讲,第3讲"
 *   node lms-auto.js --search "课程名"  # 自动搜索并进入课程
 *   node lms-auto.js --list  # 列出所有课程
 *
 * 参数：
 *   --url       课程播放页URL（从浏览器复制）
 *   --chapters  视频章节名，逗号分隔（可选，不填则自动检测）
 *   --search    搜索课程名
 *   --list      列出所有课程
 *   --user      登录用户名（必填，或用环境变量 LMS_USER / LMS_PASS）
 *   --pass      登录密码（必填）
 *   --no-quiz   不做课后测验
 *   --headless  无头模式（默认 true，加 --no-headless 显示浏览器）
 *
 * 示例：
 *   node lms-auto.js --search "课程关键词"
 *   node lms-auto.js --url "<LMS_SITE>/static/admin/#/course/play/<课程ID>"
 */

const { chromium } = require('playwright');
const fs = require('fs');

// ===== 配置 =====
const CONFIG = {
  site: process.env.LMS_SITE || 'https://your-lms.example.com',
  user: process.env.LMS_USER || '',
  pass: process.env.LMS_PASS || '',
  headless: true,
};

// ===== 解析命令行参数 =====
function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((val, i, arr) => {
    if (val.startsWith('--')) {
      const key = val.substring(2);
      const next = arr[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
      } else {
        args[key] = true;
      }
    }
  });
  return args;
}

// ===== 登录 =====
async function login(page) {
  console.log('[登录] 打开登录页...');
  await page.goto(CONFIG.site, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 2026-10: 登录页改版, 用户名框改为 el-input(placeholder 含"手机号")
  await (await page.waitForSelector(
    'input[placeholder*="手机号"], input.material-input[type="text"]',
    { timeout: 20000 }
  )).fill(CONFIG.user);
  await (await page.waitForSelector('input[type="password"]', { timeout: 10000 })).fill(CONFIG.pass);

  const cbs = await page.$$('.el-checkbox');
  if (cbs.length >= 2) await cbs[cbs.length - 1].click();
  await page.waitForTimeout(500);

  await (await page.$('button.login-btn')).click();
  await page.waitForTimeout(5000);

  if (page.url().includes('login')) {
    throw new Error('登录失败，请检查用户名密码');
  }
  console.log('[登录] ✅ 成功');
}

// ===== 搜索课程 =====
async function searchCourse(page, keyword) {
  console.log(`[搜索] "${keyword}"...`);
  const searchInput = await page.$('input[type="search"], input[placeholder*="搜索"]');
  if (searchInput) {
    await searchInput.fill(keyword);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }

  // 获取搜索结果
  const results = await page.$$eval('[class*="list-item"]', els =>
    els.filter(e => e.offsetParent !== null).map(e => ({
      text: e.innerText.trim().substring(0, 80),
    })).filter(e => e.text.length > 0)
  );

  // 提取课程ID - 需要点击进入详情页
  if (results.length > 0) {
    console.log(`[搜索] 找到 ${results.length} 个结果`);
    results.forEach((r, i) => console.log(`  ${i + 1}. ${r.text}`));

    // 点击第一个匹配的
    const courseEl = await page.$('[class*="list-item"]:has-text("' + keyword + '")');
    if (courseEl) {
      await courseEl.click();
      await page.waitForTimeout(5000);
      return page.url();
    }
  }
  return null;
}

// ===== 获取课程播放页URL =====
async function getPlayUrl(page, courseId) {
  // 进入课程详情页
  await page.goto(`${CONFIG.site}/static/admin/#/course/detail/summary/${courseId}`, {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(3000);

  // 点击"开始学习"或"立即学习"或"继续学习"
  for (const btnText of ['开始学习', '立即学习', '继续学习']) {
    const btn = await page.$(`button:has-text("${btnText}")`);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(5000);
      break;
    }
  }

  const url = page.url();
  if (url.includes('/play/')) {
    console.log('[课程] 播放页URL:', url);
    return url;
  }

  // 如果没跳转，尝试从详情页获取模块信息
  console.log('[课程] 未跳转到播放页，当前URL:', url);
  return null;
}

// ===== 查找视频元素 =====
async function findVideo(page) {
  try {
    const v = await page.$('video');
    if (v) return v;
  } catch (e) {}
  // 检查iframe
  for (const cf of page.mainFrame().childFrames()) {
    try {
      const v = await cf.$('video');
      if (v) return v;
    } catch (e) {}
  }
  return null;
}

// ===== 播放当前视频直到完成 =====
async function playUntilDone(page, name) {
  let video = await findVideo(page);
  if (!video) {
    console.log('  等待视频加载...');
    await page.waitForTimeout(5000);
    video = await findVideo(page);
  }
  if (!video) {
    console.log(`  ⚠️ 未找到video元素，跳过: ${name}`);
    return false;
  }

  // 播放
  await video.evaluate(v => { v.muted = true; v.play(); });
  await page.waitForTimeout(3000);

  const duration = await video.evaluate(v => v.duration);
  if (!duration || !isFinite(duration)) {
    console.log(`  ⚠️ 无法获取视频时长，跳过: ${name}`);
    return false;
  }
  console.log(`  📹 时长: ${Math.round(duration / 60)}分${Math.round(duration % 60)}秒`);

  let lastT = 0, stuck = 0;
  const startTime = Date.now();

  while (true) {
    await page.waitForTimeout(10000);
    const t = await video.evaluate(v => v.currentTime);
    const ended = await video.evaluate(v => v.ended);
    const paused = await video.evaluate(v => v.paused);
    const pct = (t / duration * 100).toFixed(1);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  ⏱️  ${t.toFixed(0)}/${Math.round(duration)}s (${pct}%) | 已用${elapsed}s | paused=${paused} ended=${ended}`);

    // 完成
    if (ended) {
      console.log(`  ✅ 完成: ${name}`);
      return true;
    }
    // 接近末尾后重置（平台行为）
    if (t < 1 && lastT > duration * 0.95) {
      console.log(`  ✅ 完成（视频重置）: ${name}`);
      return true;
    }
    // 暂停恢复
    if (paused) {
      console.log('  🔄 视频暂停，恢复播放...');
      await video.evaluate(v => v.play());
    }
    // 卡住检测
    if (Math.abs(t - lastT) < 1 && !paused) {
      stuck++;
      if (stuck > 3) {
        console.log('  🔄 视频卡住，重新加载...');
        await video.evaluate(v => { v.load(); v.play(); });
        stuck = 0;
      }
    } else {
      stuck = 0;
      lastT = t;
    }
  }
}

// ===== 切换到指定章节 =====
async function switchChapter(page, chapterName) {
  const clicked = await page.evaluate((name) => {
    const els = document.querySelectorAll('[class*="task"], [class*="item"], li, span, div, a');
    for (const el of els) {
      const text = (el.innerText || '').trim();
      if (text.includes(name) && text.length < 80 && el.offsetParent !== null) {
        el.click();
        return text;
      }
    }
    return null;
  }, chapterName);

  if (clicked) {
    console.log(`  🔄 切换到: ${clicked}`);
    await page.waitForTimeout(5000);
    return true;
  }
  console.log(`  ⚠️ 未找到章节: ${chapterName}`);
  return false;
}

// ===== 自动检测章节 =====
async function detectChapters(page) {
  const chapters = await page.evaluate(() => {
    const els = document.querySelectorAll('[class*="task"], [class*="node-item"]');
    return Array.from(els)
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim().match(/^任务/) && !(e.innerText || '').includes('测验'))
      .map(e => e.innerText.trim().substring(0, 60));
  });
  return chapters;
}

// ===== 做课后测验 =====
async function doQuiz(page) {
  console.log('\n[测验] 进入课后测验...');

  // 点击课后测验
  await page.evaluate(() => {
    const els = document.querySelectorAll('[class*="task"], [class*="item"], li, span, div, a');
    for (const el of els) {
      if ((el.innerText || '').trim().includes('课后测验') && (el.innerText || '').trim().length < 60 && el.offsetParent !== null) {
        el.click();
        return;
      }
    }
  });
  await page.waitForTimeout(5000);
  console.log('[测验] URL:', page.url());

  // 我知道了
  const ok = await page.$('button:has-text("我知道了")');
  if (ok) {
    await ok.click();
    console.log('[测验] 点击我知道了');
  }
  await page.waitForTimeout(3000);

  // 读取题目
  const allQ = await page.evaluate(() => {
    const items = document.querySelectorAll('.question-item');
    return Array.from(items).map((item, i) => {
      const title = item.querySelector('.question-title')?.innerText?.trim() || '';
      const options = Array.from(item.querySelectorAll('.option')).map(o => o.innerText.trim());
      const judgeOpts = Array.from(item.querySelectorAll('.exam-radio-item')).map(o => o.innerText.trim());
      return { idx: i + 1, title, options, judgeOpts };
    });
  });

  if (allQ.length === 0) {
    console.log('[测验] ⚠️ 没有找到题目');
    const text = await page.evaluate(() => document.body.innerText);
    console.log('[测验] 页面文本:', text.substring(0, 1000));
    return;
  }

  console.log(`[测验] 共 ${allQ.length} 道题`);
  allQ.forEach(q => {
    const opts = q.judgeOpts.length > 0 ? q.judgeOpts.join('/') : q.options.join(' | ');
    console.log(`  Q${q.idx}: ${q.title.substring(0, 60)} [${opts}]`);
  });

  // 自动答题规则
  const answers = allQ.map(q => {
    const t = q.title;

    // 判断题
    if (q.judgeOpts.length > 0) {
      if (t.match(/不需要|不重要|可以不|无所谓|可以忽略|无需|不必|可以不|越详细越好.*耐心/)) return '错误';
      if (t.match(/应该|必须|需要|关键|基础|前提|重要|核心|基石|保障|根本|原则|最大|首要/)) return '正确';
      return '正确';
    }

    // 单选/多选 - 关键词匹配
    const keywords = ['风险', '合规', '审查', '全面', '严格', '尽职', '充分', '独立', '审慎', '客观', '真实', '完整'];
    if (q.options.length > 0) {
      let bestOpt = -1, bestScore = 0;
      for (let j = 0; j < q.options.length; j++) {
        let score = 0;
        for (const kw of keywords) {
          if (q.options[j].includes(kw)) score++;
        }
        if (score > bestScore) { bestScore = score; bestOpt = j; }
      }
      return bestOpt >= 0 ? { optIndex: bestOpt, text: q.options[bestOpt] } : { optIndex: 0, text: q.options[0] };
    }
    return null;
  });

  // 答题
  const questionEls = await page.$$('.question-item');
  for (let i = 0; i < allQ.length; i++) {
    const ans = answers[i];
    const qEl = questionEls[i];
    if (!qEl || !ans) continue;

    if (typeof ans === 'string') {
      // 判断题
      const opts = await qEl.$$('.exam-radio-item');
      for (const opt of opts) {
        const text = await opt.innerText();
        if (text.includes(ans)) {
          await opt.click();
          console.log(`  Q${i + 1}: ${ans}`);
          break;
        }
      }
    } else {
      // 单选/多选
      const opts = await qEl.$$('.option');
      if (opts[ans.optIndex]) {
        await opts[ans.optIndex].click();
        console.log(`  Q${i + 1}: ${ans.text.substring(0, 30)}`);
      }
    }
    await page.waitForTimeout(300);
  }

  // 交卷
  console.log('\n[测验] 交卷...');
  await page.waitForTimeout(1000);
  const submitBtns = await page.$$('button:has-text("立即交卷")');
  if (submitBtns.length > 0) {
    await submitBtns[submitBtns.length - 1].click();
    await page.waitForTimeout(2000);
    const confirmBtn = await page.$('.el-message-box__btns .el-button--primary');
    if (confirmBtn) {
      await confirmBtn.click();
      console.log('[测验] 确认交卷');
    }
    await page.waitForTimeout(5000);
  }

  // 结果
  const resultText = await page.evaluate(() => document.body.innerText);
  const scoreMatch = resultText.match(/(\d+)\s*分/);
  if (scoreMatch) {
    console.log(`[测验] 得分: ${scoreMatch[1]}分`);
  }
  const passMatch = resultText.match(/已合格|已通过/);
  if (passMatch) {
    console.log('[测验] ✅ 已合格！');
  } else {
    console.log('[测验] ⚠️ 可能未合格，请检查');
  }
  console.log('[测验] 结果页文本:', resultText.substring(0, 500));
}

// ===== 主流程 =====
async function main() {
  const args = parseArgs();

  if (args.user) CONFIG.user = args.user;
  if (args.pass) CONFIG.pass = args.pass;
  if (args['no-headless'] === true) CONFIG.headless = false;

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  try {
    // 登录
    await login(page);

    let playUrl = args.url;
    let chapterList = args.chapters ? args.chapters.split(',').map(s => s.trim()) : null;

    // 搜索课程
    if (args.search && !playUrl) {
      const resultUrl = await searchCourse(page, args.search);
      if (resultUrl) {
        // 从URL提取课程ID
        const idMatch = resultUrl.match(/ksb-\d+/);
        if (idMatch) {
          playUrl = await getPlayUrl(page, idMatch[0]);
        }
      }
    }

    // 列出课程
    if (args.list) {
      console.log('\n[课程列表]');
      const courses = await page.$$eval('[class*="list-item"]', els =>
        els.filter(e => e.offsetParent !== null).map(e => e.innerText.trim().substring(0, 80))
          .filter(e => e.length > 0)
      );
      courses.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
      await browser.close();
      return;
    }

    if (!playUrl) {
      console.log('用法: node lms-auto.js --search "课程名" 或 --url "播放页URL"');
      await browser.close();
      return;
    }

    // 进入播放页
    console.log('\n[播放] 进入播放页...');
    await page.goto(playUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

    // 自动检测章节
    if (!chapterList) {
      chapterList = await detectChapters(page);
      console.log(`[播放] 检测到 ${chapterList.length} 个视频章节`);
    } else {
      console.log(`[播放] 指定 ${chapterList.length} 个章节`);
    }
    chapterList.forEach((ch, i) => console.log(`  ${i + 1}. ${ch}`));

    // 过滤掉测验章节
    const videoChapters = chapterList.filter(ch => !ch.includes('测验'));

    // 播放第一个
    console.log(`\n[播放] 开始播放第1章: ${videoChapters[0]}`);
    await playUntilDone(page, videoChapters[0]);

    // 切换播放后续
    for (let i = 1; i < videoChapters.length; i++) {
      console.log(`\n[播放] 切换到第${i + 1}章: ${videoChapters[i]}`);
      await switchChapter(page, videoChapters[i]);
      await playUntilDone(page, videoChapters[i]);
    }

    console.log('\n🎉 所有视频章节播放完毕！');

    // 课后测验
    if (args['no-quiz'] !== true) {
      await doQuiz(page);
    }

    console.log('\n🎉 全部完成！');

  } catch (err) {
    console.error('❌ 错误:', err.message);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('❌ 运行失败:', e.message); process.exit(1); });

