# 更新记录

只记对使用者有影响的改动，内部重构不写。倒序排列。

## 0.5.0（2026-11-28）

> 感谢 [@fetdog](https://github.com/fetdog)（[#18](https://github.com/miaocell/magpie-doubao-work-auth/issues/18)）、[@WeeZHnMin](https://github.com/WeeZHnMin)（[#17](https://github.com/miaocell/magpie-doubao-work-auth/issues/17)）、[@notbesttime](https://github.com/notbesttime)（[#10](https://github.com/miaocell/magpie-doubao-work-auth/issues/10)）、[@Arlo249](https://github.com/Arlo249)（[#22](https://github.com/miaocell/magpie-doubao-work-auth/issues/22)）的报告。

- **支持图片输入。** 模型标注图片能力，下游 Agent 可正常选图。上传走四步：`/alice/resource/prepare_upload` → `ApplyImageUpload` → TOS 直传 → `CommitImageUpload`；签名用 AWS S3 V4（`x-amz-date` / `x-amz-security-token`，scope 为 `cn-north-1/imagex/aws4_request`），非火山引擎原生签名。支持 png / jpeg / webp / gif，单张上限 20MB。
- 修复开启推理档时工具调用丢失（#18）：`reasoning_content` 不再参与正文判定，收到即转发。
- 风控经 429（`710012004`）返回时同样带 `X-Magpie-Refused` 并进入冷却。此前仅处理 403（`710022004`），429 按普通限流退避至 8 次。以 `decision` 字段区分风控与真实限流，冷却探测同样将 429 视为未放行（#22）。
- 模型 ID 改为固定对照表派生，去除 `doubao-` 前缀，显示为 `doubao/qwen4-max`；不再跟随上游 key 的命名变化，修复同一模型重复出现。`selectModel()` 兼容旧 ID，已选模型无需重新勾选。
- 压缩判定改为按字符数，上游限制为单条 `text_block` 约 262,144 字符；超限时返回 `prompt_too_long`（#10）。
- 修复「从客户端读取」：登录态位于 `Default` / `Profile 2`，由 `Local State` 的 `profile.last_used` 决定；文件被占用时给出退出提示。
- 浏览器登录窗口改用独立进程启动，插件重载不再中断登录；Windows 以 `taskkill /T` 回收进程树（#19）。
- 额度用尽判定同时参考实际用量，修正赠送池用满时误判整体用尽（#20）。
- 损坏的 Cookie 文件返回可读错误，不再抛出 `RangeError`。
- 历史遗留的重复模型条目需手动清理 `~/.config/magpie/providers.json` 与 `~/.cache/magpie/` 下的状态文件，清理前先退出 magpie。

## 0.4.7（2026-11-26）

> 感谢 [@WeeZHnMin](https://github.com/WeeZHnMin) 在 [#17](https://github.com/miaocell/magpie-doubao-work-auth/issues/17) 指出这两个问题。

- 短回复改为流式：依据首个非空块的首字符判定，`{` 或围栏转缓冲，其余立即转发。
- `/responses` 路径补上工具调用解析，与 `/chat/completions` 一致。
- 修复流式判定遇到空块时挂起。

## 0.4.6（2026-11-25）

- 流式输出取消 200 字符缓冲，短回复实时返回。
- `sseResponse` 改为状态机驱动，修复 `tool_calls` 组装后未发出事件。

## 0.4.5（2026-11-25）

- 修复流式输出中断。
- 补上 `/responses` 路径的工具调用事件。
- `responses` 补 `cancel()`，客户端断开时释放上游迭代器。

## 0.4.4（2026-11-24）

- 修复「从客户端读取」的三个问题：sqlite 内部页读取、profile 路径匹配、host 摘要解析。

## 0.4.3（2026-11-21）

- 带工具的请求记录整体耗时，便于定位首字延迟来源（#9）。

## 0.4.2（2026-11-21）

- 超长对话先压缩后发送；压缩后仍超限时返回 `prompt_too_long`，不再报参数错误。
- 风控冷却在验证通过后提前解除，无需等待满 5 分钟。

## 0.4.1（2026-11-20）

- 支持 Linux。登录走粘贴 Cookie，对话、流式、工具调用、额度与 Windows 一致。
- 非 Windows 平台凭据改用本地 key + AES-256-GCM 加密，此前为明文落盘。
- 模型菜单按账号类型读取，并合并 `/chat` 的 SSR 结果。订阅账号增加 Qwen 4 Max、Qwen 3.8 Max、Qwen 3.8 Flash。解析思路来自 [@GuiXunTaiYi](https://github.com/GuiXunTaiYi) 的 [PR #6](https://github.com/miaocell/magpie-doubao-work-auth/pull/6)。
- 倍率解析兼容更多文案变体，无法解析时留空。
- SSE 分帧兼容 CRLF 与单独的 CR。
- 完整消息支持 `content` 字段承载（JSON 块数组或纯文本）。
- 设备上下文改用 Cookie 中的 `s_v_web_id` 与 `launch` 返回的 `ttwid`。
- 额度区分赠送订阅（`is_membership_gift`）与活动卡（`/alice/commerce/marketing/card/list/`）。
- 额度上限改为按 `total_amount` / `used_amount` 计算，修正赠送套餐百分比恒为 0 的问题。
- 风控提示按 `decision.subtype` 区分：缺设备标识提示重新登录，频次限制提示稍后重试，语义验证提示完成验证码。
- 「从客户端读取」自动探测 Local / Roaming 下的 `Doubao` 与 `DoubaoWork`，失败时列出尝试过的路径。
- 签到仅读取状态，不代为领取。曾经尝试 Web 会话领取，失败时会消耗当日额度且不可回滚。

## 0.3.4（2026-11-18）

- 工具回复解析兼容 Markdown 围栏与前后说明文字。

## 0.3.3（2026-11-18）

- 工具回复被截断时保留可用部分，不再作废整轮（#4）。

## 0.3.2（2026-11-18）

- 风控拦截带 `X-Magpie-Refused`，magpie 不再换账号重试；同时加 5 分钟冷却。

## 0.3.1（2026-11-16）

- 支持 Codex 的 Responses API，补上 `usage` 字段。
- 错误提示改为可操作的处理步骤。

## 0.3.0（2026-11-15）

- 补上插件图标，`package.json` 与 `registry-entry.json` 均内联 SVG。
- 倍率改用 magpie 原生 `rate` 字段渲染，不再拼入模型名。
- 模型结构对齐社区约定：`cost.cache` 改为嵌套结构，补 `capabilities.interleaved` 与 `release_date`。
- 上下文写入 `limit.context`。magpie 供应商页对低于 1M 的上下文不显示徽章（[magpie#6635](https://github.com/yetone/magpie/issues/6635)）。

## 0.2.0

- 签到改为只读。领取接口返回 `biz_error.code = 3`，任务状态不变，且失败会消耗当日额度。

## 0.1.x 及更早

- 模型从 `action_bar` 的 office 模式 `model_list` 现取，不再写死。
- 三种登录方式：粘贴 Cookie、浏览器扫码、读取桌面客户端。
- 凭据按账号 DPAPI 分别加密。
- 同账号对话请求串行化，避免并发触发风控。
- 临时会话（`conversation_type = 3`）请求结束即删。
- 设备标识取自 `launch.config` 的 `web_id` / `ttwid`。