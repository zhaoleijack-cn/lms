# lms — LMS 自动学习面板

基于 **Playwright + Express** 的网课自动化工具：Web 面板管理多个学习账号与任务，无头浏览器自动完成课程搜索、视频播放、章节切换；测验/考试自动作答（题库优先，预留 LLM 作答接口）。

> ⚠️ 仅供学习浏览器自动化技术使用。请遵守所在平台的服务条款及所在单位的规章制度，滥用造成的后果由使用者自行承担。

## 架构

| 文件 | 职责 |
|---|---|
| `server.js` | 主服务（Express + WebSocket，端口 8088）：账号管理、任务下发、状态推送 |
| `lms-auto.js` | 挂课核心：登录 → 搜课 → 播放 → 换章 → 课后测验，可独立 CLI 运行 |
| `exambot.js` | 测验/考试机器人：交卷后收割正确答案入库（`answerbank.json`），重考直接命中；无题库时按注入的 `llmFn`（LLM 作答接口）作答，再兜底选第一项 |
| `public/` | 面板前端（单页） |

## 快速开始

```bash
# 1. 设置 LMS 站点地址（环境变量，或逐账号在面板里配置）
export LMS_SITE="https://your-lms.example.com"

# 2. 启动（首次构建含 Playwright 浏览器，需几分钟）
docker compose up -d --build

# 3. 打开面板
# http://<主机IP>:8088 → 「添加账号」录入学习平台的用户名密码（保存在 data/，不入库）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `LMS_SITE` | LMS 平台地址（server.js / lms-auto.js 默认取值） |
| `LMS_USER` / `LMS_PASS` | CLI 直连 `lms-auto.js` 时的默认账号 |

## 数据目录 `data/`（不入库）

- `answerbank.json` — 题库（答题过程中自动积累）
- 账号与任务状态

## CLI 直连（不走面板）

```bash
node lms-auto.js --user <账号> --pass <密码> --search "课程关键词"
node lms-auto.js --user <账号> --pass <密码> --url "<LMS_SITE>/static/admin/#/course/play/<课程ID>"
node test-exambot.js <user> <pass> [label] [课程关键词]   # 单独实测考试收割模式
```

## 技术栈

Node.js ≥ 18 · Express 4 · Playwright 1.49 · ws
