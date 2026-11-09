# AGENTS.md — agimia-erp-shell（v2，已按摸底报告修订）

## 必读文档（每次任务开始前先读）
- BASELINE.md、DEPLOY.md
- docs/video/ARCHITECTURE.md

## 项目事实（来自摸底报告，开工前如发现不符，先汇报）
- 后端：Node.js + Express，入口 server.js；主数据库 PostgreSQL（DATABASE_URL）。
- TK 达人 / Agent 中心 / 商品中心 模块使用 SQLite（modules/tk-creator-system/data/）。
- 前端：原生 HTML/CSS/JS，无构建链。
- AI 剪视频：modules/ai-video-system。页面 public/index.html；
  接口与渲染逻辑目前写在 server.js；元数据在 data/store.json（不在数据库）；
  上传文件在 data/uploads/{video,music}；成品在 data/products；临时文件在 data/tmp。
- 渲染：服务器进程内调用 ffmpeg-static / ffprobe-static，任务在内存中用 setImmediate 运行，
  服务重启会丢任务。
- AI 模型接口为 OpenAI 兼容，配置变量：OPENAI_BASE_URL、OPENAI_TEXT_MODEL、
  OPENAI_VISION_MODEL、OPENAI_TEXT_API_KEY、OPENAI_VISION_API_KEY、OPENAI_API_KEY 等（只引用变量名）。
- modules/ai-video-system/public/index.html 里存在旧的模拟函数和后方同名的真实函数，
  后声明的会覆盖前面的。修改前必须确认改的是最后生效的那个，并在任务中清理失效的旧函数。
- 主库迁移目录 database/migrations 目前没有自动执行器；
  程序启动时靠 ensureSeedData()、ensureTeamSchema() 建表。
- Agent 中心目前是 TK 模块里的规则引擎（SQLite），没有大模型调用和工具调用机制；
  "数据助手"只是占位页。

## 绝对禁止
1. 不得运行 publish-to-production.ps1、publish-to-public.ps1，不得 git push。发布只由人工执行。
2. 不得编辑、读取写入 C:\Users\Administrator\Desktop\agimia-erp-production。
3. 不得修改、删除或输出内容：.env、*.db、*.db-wal、*.db-shm、root data、
   modules/*/data（包括 modules/ai-video-system/data 里的 store.json、uploads、products）、
   node_modules、日志。任何情况下不得在对话或提交中输出密钥、令牌、密码。
4. 不得调用线上同步接口（如 POST /api/sync/*）做测试。
5. 不得 git add 视频、音频、模型等大文件，不得提交 modules/ai-video-system/data。
6. 不得修改现有数据库表的结构，不得修改现有接口的返回字段（只能新增字段，且保持旧字段不变）。
7. 测试前必须先确认 3002 使用的 DATABASE_URL 指向哪个库（只说明主机名和库名，不输出密码）。
   如果指向生产库，不得执行任何写库的测试，先汇报并等待指示。
8. 不得删除或移动用户已有的素材、成品。任何数据迁移必须在任务中明确要求，
   且迁移前先备份、可回滚。

## 开发环境
- 只在本仓库开发，用 3002 预览端口测试：
      $env:PORT = '3002'
      npm start
- 没有 test script。基础检查：node --check server.js
- 完成一个任务后：提交到本地，保持工作区干净。
  提交信息格式：`video: <阶段>-<简述>`。不要 push。

## 数据库规则（主库为 PostgreSQL）
- 新表统一前缀 video_，只新增表和字段，不改、不删现有表。
- 建表方式：仿照现有 ensureTeamSchema() 的写法，新增 ensureVideoSchema()，
  在启动时执行；全部使用 CREATE TABLE IF NOT EXISTS、ADD COLUMN IF NOT EXISTS，必须可重复执行。
- 同时在 database/migrations 放一份对应的 SQL 作为记录（可重复执行）。
- 不得把视频功能的新表建到 SQLite（TK 模块）里。

## 功能开关
- 新功能受 .env 的 AI_VIDEO_V2_ENABLED 控制，默认 false（在 .env.example 里补充说明，不改 .env）。
- 关闭时旧的 AI 剪视频行为必须与改动前一致。
- 例外：纯粹的 bug 修复（如时长显示、字段名不一致）不需要开关，但必须向后兼容。

## 代码改动原则
- server.js 影响全局，是高风险文件：新代码放到 modules/ai-video-system/ 下的新文件
  （如 routes/、services/），server.js 只做最小挂载改动。
- 一个任务只做一件事，不顺手重构不相关代码。
- 沿用现有风格，不引入新框架、新依赖；确需新增依赖时先说明理由并等待确认。
- 前端字段命名不一致时，后端同时返回新旧字段，保证旧页面不坏。

## Agent 化设计原则（为将来的视频 Agent 预留）
- 每项能力做成清晰的函数/接口（输入、输出、错误信息明确），页面与将来的 Agent 共用同一套，
  不要页面一套、Agent 一套。
- 动作分级：只读 / 可撤销 / 有成本 / 不可撤销或对外。
  发布到 TikTok、删除素材等不可撤销或对外的动作，必须人工确认。
- 所有任务记录触发来源（user / agent / schedule）和原因，写入日志。
- 渲染和 AI 调用要有并发上限、超时和失败重试上限。

## 任务收尾必须汇报
1. 改了哪些文件（列表）
2. 新增的表、字段、迁移文件
3. 如何在 3002 验证（具体命令/页面路径）
4. 对现有功能有无影响，如何确认
5. 遗留问题和下一步建议

遇到与上述规则冲突、信息缺失或需要破坏性操作时：停止，说明原因，等待确认。

## Long-term development and release workflow (2026-10-30)

This section is the current project workflow. If older release instructions in BASELINE.md or
DEPLOY.md conflict with this section, this section and the explicit prohibitions above win.

### Development

1. Work only in this repository.
2. Read BASELINE.md, DEPLOY.md, and docs/video/ARCHITECTURE.md before each task.
3. Inspect the current implementation and preserve unrelated user changes.
4. Make one focused change at a time. Do not modify protected data or secrets.
5. Run proportional checks. At minimum run `node --check` for changed JavaScript and `git diff --check`.
6. For runtime testing, use port 3002 only after confirming the database host and database name,
   without printing credentials. Never test against a production database.
7. Do not call live sync endpoints or send external messages as a test. External sends require an
   explicit user-approved verification plan.

### Handoff

1. Stage only intended source and documentation files.
2. Commit locally with `video: <stage>-<description>`.
3. Keep the worktree clean and report the commit hash, checks, verification steps, impact, and
   remaining risks.

### Release boundary

This section supersedes the earlier owner-only publish restriction in this file. Codex may perform a
normal `git push` only after the user explicitly names the remote and branch. Force pushes, branch
deletions, direct production-directory edits, and unconfirmed or unrelated release actions remain
forbidden.

Codex may run the approved publish script only after the user explicitly requests that exact
release action. Before publishing or pushing, Codex must verify that the intended commit is clean
and that the required local verification has completed. Publishing remains a separate, explicitly
confirmed action and must not be inferred from a normal coding request.
