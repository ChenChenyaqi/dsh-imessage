# 贡献指南

感谢关注 dsh-imessage——给大肥鱼完整一生的项目。

## 开发环境

- macOS（真机收发、e2e、探针只在 macOS 可跑；纯单测在 Linux/CI 也能全绿——core 层不含真 IO）
- Node ≥ 22，pnpm（建议 `corepack enable`）
- DSH desktop 0.2.x（可选，真机联调用）

```sh
git clone https://github.com/ChenChenyaqi/dsh-imessage.git
cd dsh-imessage
pnpm install
pnpm check    # typecheck + lint + build + test，提交门
```

## 怎么参与

1. fork + 特性分支（`feat/xxx`、`fix/xxx`）
2. 改动 + 配套测试
3. `pnpm check` 全绿后发 PR

## 项目规矩（重要）

### 隐私红线

任何从真实 `chat.db` 导出的数据落盘前必须脱敏：结构保真、内容替换为合成文本。测试 fixture 同样适用。

### 日志与错误的语言边界

- Error / 日志消息保持英文（架构边界，永不 i18n）；i18n 层只覆盖发给用户的 iMessage 回复文本
- 正文类内容（消息文本、AI 回复）永不入日志，只记 `chars` 字数

### 测试

- 测试目录镜像 `src/` 结构；fake / 测试工厂放 `tests/helpers/`
- 分支覆盖率基线 ≥ 93%，只升不降；不可测分支在 `scripts/coverage-report.mjs` 的 `KNOWN_SKIP` 表登记并注明原因
- 断言含数学推导时在断言旁写明算式

### 提交信息

Conventional Commits（`type: subject`），subject 不以大写英文单词开头（commitlint 会拦）；跟随现有历史，subject 用中文。

## 先读文档再动手

[docs/README.md](./docs/README.md) 是索引：架构定案在 `ARCHITECTURE.md`，路线图在 `PLAN.md`，DSH 宿主 API 事实在 `host-api/`。改动消息处理状态机（claim 时序、重试预算、双路径发送）这类核心语义前先读 `docs/`，拿不准就在 issue 里问，不要按直觉"修复"。
