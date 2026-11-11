# AGENTS.md

面向 AI 开发者的项目规范。规划与设计定案在 `docs/` 目录；本文只写
代码本身体现不出来的规矩。

## 不可违反

- **不自动 commit / push**，由维护者明确决定。
- **提交后必须 `git show --stat HEAD` 验证**内容与 message 一致——
  lefthook pre-commit 的 stash 恢复可能把未暂存文件混进提交。
- **隐私红线**：真实 `chat.db` 导出的任何数据落盘前必须脱敏——结构保真、
  内容替换为合成文本。测试 fixture 同样适用。
- **Error / 日志消息保持英文**（永不 i18n）；i18n 层只覆盖发给用户的
  iMessage 回复文本。这条是架构边界，不是语言偏好。

## 提交

- Conventional Commits（`type: subject`）；subject 不得以大写英文单词
  开头（commitlint `subject-case` 规则会拦截，`M2`、`JSONL` 均被拦过）。
- 提交门：`pnpm check` 全绿（typecheck + lint + build + test）。

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm check` | 提交门 = typecheck + lint + build + test |
| `pnpm test` | 只跑测试 |
| `pnpm test:report` | 控制台覆盖率报告（含未覆盖行号） |
| `pnpm test:report:ai` | AI 补测任务清单（未覆盖分支 + 源码行 + 留白标记） |
| `pnpm dev` | 真机手工 CLI（probe/peek/send/listen，不进 npm 包） |

## 测试

- 测试目录镜像 src 结构；fake / 测试工厂放 `tests/helpers/`。
- 分支覆盖率基线 ≥ 93%，只升不降。`scripts/coverage-report.mjs` 的
  `KNOWN_SKIP` 表登记已知留白（真 IO / 不可达分支），新增留白必须登记
  并注明原因，不许静默放过低覆盖。
- 断言含数学推导时在断言旁写明算式（延迟、覆盖率配额等期望值曾算错，
  先核数学再怀疑实现）。

## 设计定案

- 消息处理状态机（claim 时序、cursor/seen 分工、重试预算、双路径发送）
  等设计定案在 `docs/` 目录；**改动核心语义前先读 `docs/`，拿不准就问，
  不要按直觉"修复"**。
- core 层不含真 IO（数据库 / osascript / 文件系统全部依赖注入，
  CI/Linux 可跑）；真 IO 实现只出现在组装层与 dev CLI。

## 协作

- 设计遇到分叉：列出选项、各自取舍与倾向，由维护者拍板，不擅自定案。
- 发现实现 bug 与任务约束冲突（如测试要求与"禁止改 src"冲突）：停下
  上报，不越权修改约束外的文件。
- 一步一交付：功能 + 镜像测试 + check 绿即停，等维护者审视。
