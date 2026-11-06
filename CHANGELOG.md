# Changelog

本项目所有重要变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- cordis 插件骨架：`apply()` 生命周期入口与插件标识常量，经 DSH 宿主（`dsh --patch`）真实加载验证
- 工程链路：TypeScript 5.9 严格模式 + ESM 单文件打包（esbuild → `lib/index.js`，含 sourcemap），`prepack` 钩子在发布前自动构建
- `@/*` 路径别名：tsconfig `paths` 映射，typecheck / lint / 打包 / 测试四层全通
- 质量门禁 `pnpm check`（typecheck + lint + build + test 一键全绿）
- Git hooks（lefthook + commitlint）：pre-commit 跑质量门，commit-msg 强制 Conventional Commits 格式
- 双语 README（中文默认 + [English](./README.en.md) 互跳）、MIT LICENSE
- 文档：`docs/PLAN.md`（里程碑计划 M1–M4 + P1/P2 池）、`docs/ARCHITECTURE.md`（dsh-im 解构蓝图与架构决策）

<!-- 首个 tag 发布后启用版本对比链接： -->
<!-- [Unreleased]: https://github.com/<user>/dsh-imessage/compare/v0.0.1...HEAD -->
