# 北辰 API 小鲸鱼记账挂件

基于 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) v0.4.2 二次开发，面向 [北辰 API](https://beichenapi.com/dashboard)。保留角色、拖拽吸附、自定义泡泡、音效与提醒，支持 DeepSeek Harness（DSH）Web 和官方桌面端。

## 北辰版的变化

- 内置厂商改为 **北辰 API**，官网及充值入口统一进入北辰仪表盘。
- Host 使用 `GET https://beichenapi.com/v1/usage`，凭据名为 **`BEICHEN_API_KEY`**。不读取 DeepSeek 官网凭据或其账号服务。
- 钱包 key 显示账户钱包余额；限额 key 显示 **Key 剩余额度**；订阅 key 显示 **订阅剩余额度**，接口未给出可用余额时显示 `--`。
- 今日、近 7 天、历史及模型消费采用北辰返回的 **`actual_cost`（实际费用，USD）**，不套用 DeepSeek 官网价格、峰谷折扣或人民币单位。
- **用量统计属于当前 API key**，包含该 key 在其它客户端产生的消费；钱包余额属于账户。要查看整个账户所有 key 的总消费，请打开北辰仪表盘。
- 「消费同步」气泡显示两次成功同步间服务端累计实际费用的增量；多个会话共用 key 时，这是合计增量，不能据此认定某一轮对话的精确费用。
- 账本和设置使用独立的 `.bcw-*` 文件，保留旧版 `.dshw-*` 数据；切换 key 会切换独立账本。
- 默认保留服务器最近 90 天逐日记录，本机已同步记录最多保留 365 天。充值不会被计入消费，刷新不会重复累计。

## 安装

### DSH Web

在终端执行：

```bash
dsh plugin --profile web add github:zixin947/dsh-beichen-whale-widget
```

在 DSH 凭据管理中添加 `BEICHEN_API_KEY`，值为北辰「API 密钥」页面的 key，重启 DSH。
也支持在启动 DSH 的环境中设置同名变量；**凭据服务中的配置优先**。

源码安装：

```bash
git clone https://github.com/zixin947/dsh-beichen-whale-widget.git
cd dsh-beichen-whale-widget
dsh plugin --profile web add "link:$PWD"
```

### 官方桌面客户端

在桌面端会话中让 DSH 安装 `github:zixin947/dsh-beichen-whale-widget` 到当前桌面 profile，并在凭据管理添加 `BEICHEN_API_KEY`，随后重启客户端。桌面端和 Web 使用同一个 bundle。

**不要把桌面端插件装到 `web` profile**：两者加载的 profile 不同。CLI 不接受 `--profile desktop`；桌面端应由其内部插件管理执行安装。

**与原版互斥运行**：两者兼容使用 `/dsh-whale/*` 路由和页面全局标识。在同一 profile 中先停用原版 `dsh-whale-widget` 再启用本版，避免路由冲突。

## 配置与使用

1. 打开 [北辰 API 密钥页](https://beichenapi.com/keys)，选择希望统计的 key。
2. 将它存入 DSH 凭据 `BEICHEN_API_KEY`，不要把它写进仓库或泡泡配置。
3. 点击鲸鱼刷新余额；菜单 → 小鲸鱼记账可查看北辰实际费用。
4. 「北辰 API」为固定内置项。换 key 后立即手动刷新；常规刷新有 25 秒宿主缓存。
5. 角色、气泡、拖拽、音效和预算提醒沿用原版交互。默认提醒金额按 USD 显示。计费说明模块显示「北辰实际计费」，不再显示官网峰谷倒计时。

接口成功返回的零余额和零消费会正常显示。缺失字段显示 `--`；请求失败显示错误，暂时网络故障可保留最近成功数据并标记未刷新。服务端费用变化可能晚于请求完成，后续同步会补上。

现有其它厂商模板仍可手动添加；其自定义单价估算与北辰服务端实际账单不混合。未知模型不再沿用 DeepSeek 默认价格。

## 数据、凭据与回退

数据写入 `$DSH_HOME`（默认 `~/.dsh`）：

| 路径 | 内容 |
| --- | --- |
| `.bcw-usage.json` | 北辰 key 的服务端用量快照、历史记录和提醒设置 |
| `.bcw-api.json` | 自定义厂商描述；不含密钥 |
| `.bcw-size.json` / `.bcw-bubble.json` | 外观、开关、气泡设置 |
| `.bcw-turn.json` | 消费同步提示序号 |
| `beichen-whale-roles/` / `beichen-whale-audio/` / `beichen-whale-bubble-imgs/` | 自定义资源 |

密钥只由 Host 发往固定的北辰 HTTPS 用量端点，拒绝重定向；不会下发给页面、写入账本或内置图片。页面只得到余额和去除身份字段的统计数据。账本里的 key 标识使用 SHA-256 截断摘要。

停用本版并恢复原版 bundle 即可回退；旧版 `.dshw-*` 文件保持原样。北辰账本不需要迁移到旧版，也不应混入 DeepSeek 的人民币账本。

## 开发与验证

Node.js 22 或更新版本，无运行时第三方依赖：

```bash
npm test
npm run check
node tools/ci-audit-selftest.mjs
node tools/ci-audit.mjs
```

- `lib/beichen.mjs`：固定端点取数、USD 实际费用解析、按 key 隔离的快照账本。
- `lib/index.js`：DSH Host 集成、26 条 `/dsh-whale/*` 路由及原版交互服务；全部 **26 个** `/dsh-whale/*` 路由都已接入信任栅栏。
- `assets/whale-widget.js`：浏览器挂件，原版角色、泡泡、音效和菜单。
- `test/`：余额/额度、真实费用口径、缺失字段、换 key、跨日、重复同步、错误处理和 Host 路由测试。

本仓库从 GitHub 安装与更新；尚未发布到 npm。更新检查入口不会提示安装回原版包。推送触发 CI，不会自动发布 npm。

## 来源与许可

感谢原作者 MeteorNOX。保留上游 Git 历史与 MIT 版权声明；北辰适配由 zixin947 维护。本项目是独立社区适配，不代表北辰或 DSH 官方。

代码按 [MIT](LICENSE) 分发。图片、动图和音效的来源与使用范围沿用 [PROVENANCE.md](PROVENANCE.md)，没有扩大授权范围。
