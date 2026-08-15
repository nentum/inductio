# Contributing

感谢你愿意帮助改进 Inductio。

## 开始之前

- 较大的语义或公开 API 变更，请先开 Issue 说明问题、边界和兼容方式；
- 修复 Bug 时，尽量先补一个能够复现问题的测试；
- 不要让模型输出、政策插件或普通文本直接取得外部能力；
- 新的持久格式或身份规则必须有新的版本标识，不能静默改变旧数据的含义。

## 本地验证

要求 Node.js `>=22.23.0`，推荐使用 npm `10.9.8`：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
```

真实模型测试是可选项，会消耗外部额度：

```bash
npm run test:live:models
```

请勿把真实密钥、`.env`、SQLite 数据文件或 npm 凭据提交进仓库。

## Pull Request

请在说明中写清楚：

1. 改了什么；
2. 为什么需要改；
3. 是否改变持久身份、公开 API 或失败分类；
4. 跑过哪些测试。

提交贡献即表示你同意按本仓库的 [MIT License](LICENSE) 发布该贡献。
