# 更新记录

只记对使用者有影响的改动，内部重构不写。倒序排列。

版本号：大改动动第二位（`0.2` → `0.3`），日常修复加第三位（`0.3.0` → `0.3.1`）。没有 npm 包也没有发行版，所以这里就是唯一的版本依据。

## 0.3.2（2026-11-18）

- **工具回复被截断时不再让整轮请求失败。** 豆包偶尔在长工具参数中途停止输出，正文 JSON 缺结尾，`decodeReply` 直接 `JSON.parse` 整段就抛 `invalid_tool_response`（502），调用方看到的是整轮 provider error。现在解析失败会重开一次会话重试；仍失败则把正文当普通回复返回（`finish_reason=stop`），会话不中断。
- **JSON 前后带解释或 Markdown 围栏时也能解析。** 之前只认正文首字符是 `{` 的情况，现在依次尝试围栏内、整段、首尾大括号之间三段。

## 0.3.1（2026-11-16）

- **支持 Codex 的 Responses 协议。** Codex 默认 `wire_api = "responses"`，发的是 `input` 而不是 `messages`，之前会被当成「请求缺少 messages」拒掉，Codex 侧只看到 `server_error` 或 `delegated input protocol violation`。现在请求和响应都做了双向折叠，Codex 不用改配置。
- **补上 `usage` 字段。** 豆包的事件流不带 token 统计，之前客户端一律显示 0，Codex 会因此误判上下文占用。现在按字符估算补上（中日韩 1 token/字，其余 4 字符/token），只给量级，不用于计费。
- **上游错误提示改成能照做的。** 风控拦截时豆包也回 `rate limited`，容易被当成限流去重试。现在按错误码补一句明确提示，例如 403 会提示「打开 doubao.com/chat 手动发一句话过验证」。
- **推理档位传数字时归一化。** 少数客户端按 `3/4/5…` 传 `reasoning_effort`，之前会被静默丢弃，现在映射成 `low/medium/high/xhigh/max`。
- **补了 `710020202` 的映射。** 这个码和 `710010202`（`common invalid param`）相近但不同，常见于会话 id 复用被拒，之前落到通用的 `upstream_error`。

## 0.3.0（2026-11-15）

- **补上市场卡片图标。** `package.json` 的 `magpie.icon` 和 `registry-entry.json` 都填了内联 SVG，不再显示默认方块。
- **倍率改用 magpie 原生的 `rate` 字段。** 之前把倍率拼进模型名（`GLM 5.3 · 0.80x`），现在名字保持干净，界面自己渲染成徽章，和其他插件一致。
- **模型结构对齐社区约定。** `cost.cache` 改成嵌套的 `{ read, write }`，补齐 `capabilities.interleaved` 和 `release_date`。
- **上下文写进 `limit.context`。** 顺便说明：magpie 的供应商页目前只有 `context >= 1M` 才显示上下文徽章，低于 1M 的（256K / 300K）在这一页看不到，路由页正常显示。已给 magpie 提了 [issue #6635](https://github.com/yetone/magpie/issues/6635) 询问这是阈值还是遗漏。

## 0.2.0

- **签到改回纯只读。** 领取接口 `POST /alice/ug/campaign/item/reward/claim/` 能调通，但回执固定是 `biz_error.code = 3`「领取结果确认中」，任务状态不变。带全套浏览器上下文直调结果一致，说明卡在客户端侧的校验上，纯 HTTP 绕不过。插件不再发注定失败的写请求（高频失败是风控最敏感的模式），只读状态。

## 0.1.x 及更早

- 从账号 `action_bar` 的 office 模式 `model_list` 现取模型，不再写死。
- 三种登录方式：粘贴 Cookie、一次性浏览器窗口扫码、读桌面客户端。
- 凭据按账号 DPAPI 分别加密，多账号互不干扰。
- 同账号对话请求串行化，避免并发打上游触发风控。
- 临时会话（`conversation_type = 3`）请求结束即删，不在客户端侧边栏留垃圾。
- 设备标识改用 `launch.config` 里的 `web_id` / `ttwid`。
