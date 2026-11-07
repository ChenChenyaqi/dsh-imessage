// Conventional Commits 规范：<type>(<scope>?): <subject>
// type 限定为：feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
const config = {
  extends: ['@commitlint/config-conventional'],
};

export default config;
