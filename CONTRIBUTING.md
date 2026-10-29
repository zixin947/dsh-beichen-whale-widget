# 贡献指南

本仓库是 [原版小鲸鱼](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的北辰 API 适配，由 zixin947 维护。上游版权与素材来源见 LICENSE 和 PROVENANCE.md。

## 范围

- 北辰接口与快照账本位于 `lib/beichen.mjs`，Host 集成在 `lib/index.js`，前端在 `assets/whale-widget.js`。
- DSH bundle 挂载声明在 `cordis.patch.yml`；Web 和桌面采用同一个包。
- 不把北辰钱包、Key 额度和订阅额度混为一谈；账单统一使用 USD `actual_cost`。
- 密钥、网页登录态、个人账本、会话记录、临时测试数据不得提交。

## 提交前验证

```bash
npm test
npm run check
node tools/ci-audit-selftest.mjs
node tools/ci-audit.mjs
git diff --check
```

改界面需要截图；未实测的平台应明确说明。PR 使用中文，按仓库模板填写，Verification 仅勾选实际完成项。

推送只运行 CI，不发布 npm。GitHub 源码安装是当前分发方式；不要把 fork 更新指向原版包。
