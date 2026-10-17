// test-exambot.js — 用指定账号实测 exambot 收割模式（账号经命令行传入，不落库）
const { chromium } = require('playwright');
const { runExamFlow, loadBank, bankSize } = require('/app/data/exambot.js');
const SITE = process.env.LMS_SITE || '';
if (!SITE) { console.error('请先设置环境变量 LMS_SITE'); process.exit(1); }
const COURSE_KEYWORD = process.argv[5] || '示例课程';
// 账号从命令行取: node test-exambot.js <user> <pass> [label]
const ACC = { user: process.argv[2], pass: process.argv[3], label: process.argv[4] || 'test' };
if (!ACC.user || !ACC.pass) { console.error('用法: node test-exambot.js <user> <pass> [label]'); process.exit(1); }

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const log = m => console.log(m);

  try { await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
  const userInput = await page.waitForSelector('input[placeholder*="手机号"], input.material-input[type="text"]', { timeout: 20000 });
  await userInput.fill(ACC.user);
  const passInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await passInput.fill(ACC.pass);
  const cbs = await page.$$('.el-checkbox');
  if (cbs.length >= 2) await cbs[cbs.length - 1].click();
  await page.waitForTimeout(300);
  await (await page.waitForSelector('button.login-btn', { timeout: 10000 })).click();
  await page.waitForTimeout(8000);
  log('[登录] ok: ' + page.url());

  // 播放页: 优先用命令行直连URL, 否则走学习页导航
  let play = null, courseId = null;
  if (process.argv[5]) {
    try { await page.goto(process.argv[5], { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
    await page.waitForTimeout(8000);
    if (page.url().includes('/course/play/')) play = page;
  }
  if (!play) {
    try { await page.goto(SITE + '/static/admin/#/learning/course', { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (e) {}
    let contBtn = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    contBtn = page.locator('button:has-text("继续学习"):visible, a:has-text("继续学习"):visible, button:has-text("去学习"):visible, a:has-text("去学习"):visible, button:has-text("再次学习"):visible, a:has-text("再次学习"):visible').first();
    if (await contBtn.count() > 0) break;
  }
  if (contBtn && await contBtn.count() > 0) {
    const npP = ctx.waitForEvent('page', { timeout: 30000 }).catch(() => null);
    await contBtn.click({ timeout: 10000 }).catch(e => log('[导航] 按钮点击失败: ' + e.message.substring(0, 50)));
    let pop = null, dlgDumped = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      pop = ctx.pages().find(p => p.url().includes('/course/play/')) || null;
      if (page.url().includes('/course/play/')) { play = page; break; }
      if (pop) { play = pop; break; }
      if (!dlgDumped) {
        const dlg = await page.evaluate(() => {
          const box = Array.from(document.querySelectorAll('.el-message-box, .el-dialog')).find(e => e.offsetParent !== null);
          return box ? (box.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 120) : null;
        }).catch(() => null);
        if (dlg) { log('[导航] 点击后弹窗: ' + dlg); dlgDumped = true; }
      }
    }
  }
  }
  if (play) {
    const m = play.url().match(/aid=([\w-]+)/);
    courseId = m ? m[1] : null;
  }
  if (!play || !courseId) {
    log('[导航] 未能进入播放页 play=' + !!play + ' url=' + (play ? play.url() : page.url()));
    await browser.close(); return;
  }
  log('[导航] courseId=' + courseId + ' 播放页: ' + play.url());

  // 完整考试流程
  const result = await runExamFlow(play, courseId, { log, label: COURSE_KEYWORD.substring(0, 10) });
  log('[结果] ' + JSON.stringify(result, null, 1));

  const bank = loadBank();
  log('[题库] 课程题数: ' + bankSize(bank, courseId));
  await play.screenshot({ path: '/app/data/exambot-test.png', fullPage: true }).catch(() => {});
  console.log('TEST DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
