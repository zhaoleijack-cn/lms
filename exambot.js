// exambot.js — LMS 考试自动答题机器人（独立模块，设计为可被 server.js require）
// 依赖: 仅 node 内置模块; 页面对象由调用方传入 (Playwright Page)
// 核心机制: 交卷后成绩页公布每题正确答案 → 收割入库 → 后续账号/重考直接命中题库
const fs = require('fs');
const crypto = require('crypto');

const BANK_FILE = '/app/data/answerbank.json';
const PASS_LINE = 60;

// ---------- 题库 ----------
function loadBank() {
  try { return JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveBank(bank) {
  try { fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 1)); return true; }
  catch (e) { return false; }
}
function normText(s) {
  return (s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[0-9]+[、.]/, '')
    .replace(/[（(]\d+(\.\d+)?分[)）]$/g, '')
    .replace(/^[A-D][\s.、]/, '')
    .replace(/[。．，,？?！!：:；;""''"']/g, '');
}
function hashTitle(t) { return crypto.createHash('sha1').update(normText(t)).digest('hex').substring(0, 12); }
function bankSize(bank, courseId) { const c = bank[courseId]; return c ? Object.keys(c.questions || {}).length : 0; }
function upsertQuestion(bank, courseId, q) {
  if (!bank[courseId]) bank[courseId] = { examId: null, updatedAt: null, questions: {} };
  const c = bank[courseId]; const key = hashTitle(q.title);
  const prev = c.questions[key];
  c.questions[key] = {
    title: q.title, type: q.type || (prev && prev.type) || 'single',
    correctTexts: q.correctTexts, options: q.options || (prev && prev.options) || [],
    confirmed: true, source: q.source || 'harvest',
    hits: (prev && prev.hits) || 0, updatedAt: new Date().toISOString()
  };
  c.updatedAt = new Date().toISOString();
  return key;
}

// ---------- 进入考试（处理"还剩X次机会"弹窗 + 考场说明封面） ----------
async function enterExam(play, log) {
  log = log || (() => {});
  const quizItem = play.locator('li.item:has-text("课后测验")').first();
  if (await quizItem.count() === 0) throw new Error('未找到「课后测验」章节条目');
  await quizItem.click().catch(e => log('[测验] 点击测验条目失败: ' + e.message));
  let attemptsLeft = null, started = false;
  for (let i = 0; i < 60; i++) { // 最多30s
    await play.waitForTimeout(500);
    // 1) 弹窗: 您目前还剩X次考试机会
    const modal = await play.evaluate(() => {
      const box = Array.from(document.querySelectorAll('.el-message-box')).find(e => e.offsetParent !== null);
      if (!box) return null;
      const m = (box.innerText || '').match(/还剩(\d+)次考试机会/);
      const btn = box.querySelector('button.el-button--primary') || Array.from(box.querySelectorAll('button')).find(b => /重新答题|确定/.test(b.textContent || ''));
      return { text: (box.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 80), left: m ? parseInt(m[1]) : null, btn: btn ? btn.textContent.trim() : null };
    }).catch(() => null);
    if (modal && modal.btn) {
      if (modal.left !== null) attemptsLeft = modal.left;
      log('[测验] 弹窗: ' + modal.text + (modal.left !== null ? ' (剩余次数=' + modal.left + ')' : ''));
      await play.evaluate(() => {
        const box = Array.from(document.querySelectorAll('.el-message-box')).find(e => e.offsetParent !== null);
        const btn = box.querySelector('button.el-button--primary') || Array.from(box.querySelectorAll('button')).find(b => /重新答题|确定/.test(b.textContent || ''));
        if (btn) btn.click();
      }).catch(() => {});
      await play.waitForTimeout(1500);
      continue;
    }
    // 2) 考场说明封面: 开始答题
    const cover = await play.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && /开始答题|继续答题/.test(e.textContent || ''));
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (cover) { started = true; log('[测验] 点击「开始答题」'); }
    // 3) 题目出现?
    const n = await play.evaluate(() => document.querySelectorAll('.question-item').length).catch(() => 0);
    if (n > 0) { log('[测验] 题目已渲染: ' + n + ' 题'); return { attemptsLeft, started, questionCount: n }; }
  }
  return { attemptsLeft, started, questionCount: 0 };
}

// ---------- 逐题作答（题库优先, 文本匹配, 真实点击, DOM验证） ----------
async function answerExam(play, bank, courseId, opts) {
  const log = (opts && opts.log) || (() => {});
  const llmFn = (opts && opts.llmFn) || null; // async (title, optionTexts[]) => 选项文本数组 | null
  const items = play.locator('.question-item');
  const total = await items.count();
  let bankHit = 0, guessed = 0, verified = 0; const unknownTitles = [];
  for (let qi = 0; qi < total; qi++) {
    const item = items.nth(qi);
    const rawTitle = await item.locator('.question-title').innerText().catch(() => '');
    const title = rawTitle.replace(/\s+/g, ' ').trim();
    const key = hashTitle(title);
    const entry = (bank[courseId] && bank[courseId].questions && bank[courseId].questions[key]) || null;
    const isJudge = await item.locator('.exam-radio-item').count() > 0;
    let clicked = false;
    if (isJudge) {
      // 判断题: correctTexts = ['正确'] 或 ['错误']
      let want = '正确';
      if (entry && entry.correctTexts && entry.correctTexts.length) want = /错/.test(entry.correctTexts[0]) ? '错误' : '正确';
      const t = item.locator('.exam-radio-item:has-text("' + want + '")').first();
      const before = await t.evaluate(e => e.outerHTML).catch(() => '');
      await t.click({ timeout: 4000 }).catch(e => log('[测验] 判断题点击失败 Q' + (qi + 1) + ': ' + e.message.substring(0, 40)));
      await play.waitForTimeout(200);
      const after = await t.evaluate(e => e.outerHTML).catch(() => '');
      clicked = before !== after;
      if (!clicked) { // 兜底: 点内部 span
        await t.locator('span').first().click({ timeout: 2000 }).catch(() => {});
        await play.waitForTimeout(200);
        const a2 = await t.evaluate(e => e.outerHTML).catch(() => '');
        clicked = before !== a2;
      }
      if (entry) bankHit++; else guessed++;
    } else {
      // 单选/多选: 按"选项文本"匹配 li[id]
      const lis = await item.locator('li[id]').all();
      const lisTxt = [];
      for (const li of lis) lisTxt.push(normText(await li.innerText().catch(() => '')));
      let wantTexts = null;
      if (entry && entry.correctTexts && entry.correctTexts.length) {
        wantTexts = entry.correctTexts.map(normText); bankHit++;
      } else {
        guessed++; unknownTitles.push(title.substring(0, 40));
        if (llmFn) {
          try {
            const raw = lis.map((li, i) => 'ABCD'[i] + ' ' + lisTxt[i]).join('\n');
            const ans = await llmFn(title, raw);
            if (ans) wantTexts = [].concat(ans).map(normText);
          } catch (e) { log('[测验] LLM调用失败 Q' + (qi + 1) + ': ' + e.message); }
        }
      }
      for (let oi = 0; oi < lis.length; oi++) {
        const isWant = wantTexts
          ? wantTexts.some(w => w && (lisTxt[oi].indexOf(w) !== -1 || w.indexOf(lisTxt[oi]) !== -1))
          : oi === 0; // 无题库无LLM: 兜底选第一项
        if (!isWant) continue;
        const li = lis[oi];
        const before = await li.evaluate(e => e.outerHTML).catch(() => '');
        await li.click({ timeout: 4000 }).catch(e => log('[测验] 选项点击失败 Q' + (qi + 1) + '-' + oi + ': ' + e.message.substring(0, 40)));
        await play.waitForTimeout(200);
        const after = await li.evaluate(e => e.outerHTML).catch(() => '');
        if (before !== after) { clicked = true; }
        else {
          await li.locator('span').first().click({ timeout: 2000 }).catch(() => {});
          await play.waitForTimeout(200);
          const a2 = await li.evaluate(e => e.outerHTML).catch(() => '');
          if (before !== a2) clicked = true;
        }
        if (!wantTexts) break; // 兜底只选一个
      }
    }
    if (clicked) verified++;
  }
  log('[测验] 作答完成: 共' + total + '题, 题库命中' + bankHit + ', 兜底/LLM ' + guessed + ', 点击验证成功 ' + verified + '/' + total);
  return { total, bankHit, guessed, verified, unknownTitles };
}

// ---------- 交卷 ----------
async function submitExam(play, log) {
  log = log || (() => {});
  const ok = await play.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && /立即交卷/.test(e.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  }).catch(() => false);
  if (!ok) { log('[测验] 未找到交卷按钮'); return false; }
  await play.waitForTimeout(1500);
  // 确认弹窗链: 确定交卷 → (有题未答确认) → 试卷已提交(优先点「查看成绩」跳转成绩页)
  for (let i = 0; i < 4; i++) {
    const clicked = await play.evaluate(() => {
      const box = Array.from(document.querySelectorAll('.el-message-box')).find(e => e.offsetParent !== null);
      if (!box) return null;
      const viewBtn = Array.from(box.querySelectorAll('button')).find(b => /查看成绩|查看解析/.test(b.textContent || ''));
      const btn = viewBtn || box.querySelector('button.el-button--primary') || box.querySelector('button');
      const txt = (box.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 80);
      if (btn) btn.click();
      return txt + (viewBtn ? ' [点击查看成绩]' : '');
    }).catch(() => null);
    if (clicked) log('[测验] 确认弹窗: ' + clicked);
    await play.waitForTimeout(1800);
    const done = await play.evaluate(() => /得分[:：]?\s*\d+|正确答案/.test(document.body.innerText || '')).catch(() => false);
    if (done) break;
  }
  log('[测验] 已交卷');
  return true;
}

// ---------- 成绩页收割正确答案 → 写入题库 ----------
async function harvestReview(play, bank, courseId, examId, source) {
  const out = { score: null, pass: false, harvested: 0, reviewAvailable: false };
  // 等成绩页出现; 若超时尝试点「查看成绩/查看解析」按钮
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 12; i++) {
      const has = await play.evaluate(() => /得分[:：]?\s*\d+|正确答案/.test(document.body.innerText || '')).catch(() => false);
      if (has) break;
      await play.waitForTimeout(1000);
    }
    const has = await play.evaluate(() => /得分[:：]?\s*\d+|正确答案/.test(document.body.innerText || '')).catch(() => false);
    if (has) break;
    if (round === 0) {
      const clicked = await play.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && /查看成绩|查看解析/.test(e.textContent || ''));
        if (b) { b.click(); return true; }
        return false;
      }).catch(() => false);
      if (!clicked) break;
    }
  }
  const data = await play.evaluate(() => {
    const bt = document.body.innerText || '';
    const items = Array.from(document.querySelectorAll('.question-item'));
    return {
      score: (bt.match(/得分[:：]?\s*(\d+(?:\.\d+)?)/) || [null, null])[1],
      pass: /已合格|状态[:：]\s*合格/.test(bt) || /合格/.test((bt.match(/状态[:：]\s*([^\s]{0,6})/) || [''])[1] || ''),
      questions: items.map(it => {
        const inner = it.innerText || '';
        const title = ((it.querySelector('.question-title') || {}).innerText || '').replace(/\s+/g, ' ').trim();
        const cm = inner.match(/正确答案[:：]\s*([A-D]{1,6}|正确|错误)/);
        const opts = Array.from(it.querySelectorAll('li[id], .exam-radio-item')).map(o => (o.innerText || '').replace(/\s+/g, ' ').trim());
        return { title, correct: cm ? cm[1] : null, opts };
      })
    };
  }).catch(e => ({ err: e.message, questions: [] }));
  if (data.err) return Object.assign(out, { err: data.err });
  out.score = data.score !== null ? parseFloat(data.score) : null;
  out.pass = !!data.pass || (out.score !== null && out.score >= PASS_LINE);
  if (!data.questions.length) return out;
  if (!bank[courseId]) bank[courseId] = { examId: examId || null, updatedAt: null, questions: {} };
  if (examId) bank[courseId].examId = examId;
  for (const q of data.questions) {
    if (!q.title || !q.correct) continue;
    out.reviewAvailable = true;
    let correctTexts;
    if (q.correct === '正确' || q.correct === '错误') { correctTexts = [q.correct]; }
    else {
      correctTexts = [];
      for (const ch of q.correct) {
        const idx = ch.charCodeAt(0) - 65; // A=0, 按成绩页渲染顺序
        const raw = q.opts[idx];
        if (raw) correctTexts.push(raw.replace(/^[A-D][\s.、]/, '').trim());
      }
    }
    if (!correctTexts.length) continue;
    upsertQuestion(bank, courseId, { title: q.title, correctTexts, options: q.opts.map(o => o.replace(/^[A-D][\s.、]/, '').trim()), source: source || 'harvest' });
    out.harvested++;
  }
  saveBank(bank);
  return out;
}

// ---------- 完整考试流程（供 server.js 任务流调用） ----------
async function runExamFlow(play, courseId, opts) {
  const log = (opts && opts.log) || (() => {});
  const llmFn = (opts && opts.llmFn) || null;
  const label = (opts && opts.label) || courseId;
  const result = { courseId, attemptsUsed: 0, scores: [], harvested: 0, bankSize: 0, status: 'unknown', detail: [] };

  let bank = loadBank();
  const known = bankSize(bank, courseId);
  log('[测验] 课程 ' + label + ' 题库现有 ' + known + ' 题');

  // 课程完成保护: 章节列表中测验状态图标 success/done → 已合格, 跳过 (防误重考覆盖合格分)
  const quizState = await play.evaluate(() => {
    const li = Array.from(document.querySelectorAll('li.item')).find(e => /课后测验/.test(e.innerText || ''));
    if (!li) return 'missing';
    const icon = li.querySelector('.lrn-status i');
    const cls = icon ? icon.className.toString() : '';
    if (/fail|error/.test(cls)) return 'failed';
    if (/success|done|finish|complete|pass|right|check/i.test(cls)) return 'passed';
    return 'pending';
  }).catch(() => 'unknown');
  log('[测验] 测验条目状态: ' + quizState);
  if (quizState === 'passed') {
    result.status = 'already-passed';
    log('[测验] ✅ 该课程测验已合格, 跳过 (不做重考, 保护已得分数)');
    return result;
  }

  // 第一次进入
  let enter = await enterExam(play, log);
  if (!enter.questionCount) {
    result.status = 'enter-failed';
    result.detail.push('未能进入考试(题目未渲染)');
    return result;
  }
  // 保护栏: 仅剩1次机会且题库覆盖不足 → 不作答不交卷, 直接退出
  const coverageKnown = known > 0;
  if (enter.attemptsLeft === 1 && !coverageKnown) {
    log('[测验] ⚠️ 仅剩1次考试机会且题库为空 — 保守起见不作答不交卷, 交还人工');
    result.status = 'aborted-last-attempt';
    return result;
  }

  // 第一次作答+交卷 (首卷为收割卷: 题库命中多少算多少, 其余兜底)
  await answerExam(play, bank, courseId, { log, llmFn });
  await submitExam(play, log);
  result.attemptsUsed++;
  let harvest = await harvestReview(play, bank, courseId, null, 'harvest:' + label);
  result.scores.push(harvest.score); result.harvested += harvest.harvested;
  log('[测验] 第1卷得分: ' + harvest.score + (harvest.pass ? ' 已合格' : ''), '| 收割正确答案 ' + harvest.harvested + ' 题' + (harvest.reviewAvailable ? '' : ' (成绩页未公布答案!)'));
  bank = loadBank();

  // 不合格且还有机会 → 立即用新题库重考 (仅在题库确实收割到答案时, 防止空题库浪费重考)
  const canRetake = harvest.score !== null && harvest.score < PASS_LINE
    && (enter.attemptsLeft === null || enter.attemptsLeft >= 2)
    && (harvest.harvested > 0 || coverageKnown);
  if (canRetake) {
    log('[测验] 未合格, 用更新后的题库立即重考');
    let enter2 = await enterExam(play, log);
    if (enter2.questionCount) {
      await answerExam(play, bank, courseId, { log, llmFn });
      await submitExam(play, log);
      result.attemptsUsed++;
      const h2 = await harvestReview(play, bank, courseId, null, 'retake:' + label);
      result.scores.push(h2.score); result.harvested += h2.harvested;
      log('[测验] 第2卷得分: ' + h2.score + (h2.pass ? ' 已合格 ✓' : ''));
    } else {
      result.detail.push('重考进入失败');
    }
  }
  const finalScore = result.scores[result.scores.length - 1];
  result.status = finalScore === null ? 'no-score' : (finalScore >= PASS_LINE ? 'passed' : 'failed');
  result.bankSize = bankSize(loadBank(), courseId);
  log('[测验] 流程结束: ' + result.status + ', 本次耗用次数 ' + result.attemptsUsed + ', 题库现 ' + result.bankSize + ' 题');
  return result;
}

module.exports = { loadBank, saveBank, normText, hashTitle, bankSize, upsertQuestion, enterExam, answerExam, submitExam, harvestReview, runExamFlow, BANK_FILE };
