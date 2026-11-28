# 更新记录

只记对使用者有影响的改动，内部重构不写。倒序排列。

## 0.4.9（2026-11-28）

- **支持图片输入了。** 之前 `image` 一直标成 `false`，因为上传链路没打通——现在打通了。豆包不走内联 base64，要走四步（申请凭据 → 申请上传地址 → TOS 直传 → 提交），中间用的是 **AWS S3 V4 签名**，不是火山引擎原生那套：头是 `x-amz-date` / `x-amz-security-token`，`Authorization` 形如 `AWS4-HMAC-SHA256 Credential=<AK>/<date>/cn-north-1/imagex/aws4_request`。之前按火山文档用 `X-Date` + `HMAC-SHA256` + `/request` 一直吃 `InvalidAuthorization`，抓网页真实请求才看出来。
  实测：发一张 1×1 的 PNG，模型能说出它的尺寸和颜色，说明真的读到了图。
  用 magpie 转给其他 Agent 时，图片输入可用；改 UI、对着截图解释、提取文字这些场景都能走了。
  支持 png / jpeg / webp / gif，单张上限 20MB。

## 0.4.8（2026-11-28）

> 感谢 [@fetdog](https://github.com/fetdog)（[#18](https://github.com/miaocell/magpie-doubao-work-auth/issues/18)）、[@WeeZHnMin](https://github.com/WeeZHnMin)（[#17](https://github.com/miaocell/magpie-doubao-work-auth/issues/17)）、[@notbesttime](https://github.com/notbesttime)（[#10](https://github.com/miaocell/magpie-doubao-work-auth/issues/10)）的报告，这一版主要是他们指出来的问题。

- **开推理档时工具调用会丢（#18）。** 豆包开推理档会先流一大段 `reasoning_content`，正文要等推理结束才来。0.4.7 的形态判定把「只有 reasoning、没有正文」当成可以判定，于是判成普通正文，后面的工具 JSON 被原样透传给客户端——客户端只看到一坨原文，这一轮调用直接丢失，表现出来就是「首字特别慢、而且不是流式，是瞬间出一大段」。
  现在 `reasoning_content` 完全不参与判定、收到就转发；等不到正文时按缓冲处理（判错成缓冲只是慢几秒，判错成正文会丢掉整轮调用，代价不对等）。真机验证：`reasoning_effort: max` + 工具定义，4 块 reasoning 先到，`tool_calls` 正确解析、正文为空。
- **压缩判定改成按字符数。** 上游限制的是单条 `text_block` 的字符数（约 262,144 = 256 KiB），跟字节数、token 数都无关——中文 20 万字符有 60 万字节，按旧的字节判会被白白压掉。超限时新增 `prompt_too_long` 错误，直接说明字符数和上限，不再让人对着「参数错误」猜。
- **「从客户端读取」修好了（方向和之前不同）。** 之前按 issue 里说的去 `User Data\aha\users\<hash>\profile_explorer` 找，实测那个目录下只有缓存、没有 Cookies 文件。真实登录态在标准的 `Default` / `Profile 2` 下，具体哪个由 `Local State` 的 `profile.last_used` 决定。另外客户端开着时激活的 profile 文件是独占锁的，现在会直接说明「先把豆包工作完全退出」而不是吐一个 `EBUSY`。
- **浏览器登录窗口不再被顺带杀掉（#19）。** 原来启动浏览器用 `detached: false`，magpie 重载插件或重启时子进程会被一起带走，用户正输验证码窗口就没了。改成独立进程，并在 Windows 上用 `taskkill /T` 杀进程树收尾。启动探测也分了情况：进程一退出就立刻报真实原因，不再干等十几秒。
- **活动赠送额度用满后不再被当成整体用量（#20）。** 服务端在已用满时仍可能返回 `usage_exhausted: false`，只看这个标志会让 magpie 拿满格的赠送池当总进度、显示「几乎用尽」，而订阅额度其实还剩很多。现在同时按窗口实际用量判断。
- **损坏的 Cookie 文件给出可读错误。** 空文件或截断文件以前抛 `RangeError: Attempt to access memory outside buffer bounds`，现在说清楚「文件不完整，可能客户端还没写完」。

## 0.4.7（2026-11-26）

> 感谢 [@WeeZHnMin](https://github.com/WeeZHnMin) 在 [#17](https://github.com/miaocell/magpie-doubao-work-auth/issues/17) 里指出这两个问题。

- **短回复也能流式了。** 0.4.6 里判断「这段输出是工具 JSON 还是正文」要攒够 200 字符，短回复永远攒不够，于是一直等到整段生成完才吐字——实测那段是 6-12 秒，等于没流式。现在只看第一个非空块的首字符：`{` 或 ` ``` ` 就转缓冲，其余立刻流式转发。日常短问答（「改这一行」「是/否」）受益最明显。
- **修了 `/responses` 流式路径不解析工具调用。** 那条路径把上游增量直接当正文发给客户端，带工具时 `{"content":"","tool_calls":[...]}` 会原样出现在正文里，Codex 收不到 `function_call`。现在和 `/chat/completions` 一样收完整段后解析。
- **修了判定循环遇到空块卡死。** `pull()` 只有在 `enqueue` 之后才会被再次调用，空块直接 `return` 会让流挂住。测试覆盖到了这个。

## 0.4.6（2026-11-25）

- **流式输出修好了，顺带抓到一个更严重的 bug。** 之前带工具的请求一律整段缓冲（要收完才能解析 `tool_calls`），所以纯文本回复也要等全部生成完才吐字——issue #9 的「首字 15-25 秒」和 #14 的「看不到工作过程」都是这个原因。现在先收一小段判断形态：像 JSON 就继续缓冲，像正文就边收边转发。实测首字比总耗时早约 2.4 秒。
- **修了工具调用的产出丢失。** 在给流式加分支时发现：`tool_calls` 组装好之后没有被 `emit` 出去，客户端只收到一个空的 `finish_reason=tool_calls` 事件，实际调用内容是空的。这个 bug 只影响 0.4.5 之前的流式路径，现在补上了。
- `chat.mjs` 之前没有任何专属测试，这次补了 `looksLikeToolJson` 的判断边界（正文里出现大括号不能误判）和 `sseResponse` 的两条路径（流式 / 缓冲）、取消处理。

## 0.4.5（2026-11-25）

- **客户端断开时会主动放掉上游请求。** `/responses` 这条链路（Codex 用 `wire_api = "responses"` 时走它）之前没有 `cancel()` 处理器：用户在客户端取消或超时断开后，上游还会继续把回复生成完，白花额度和时间。现在断开就停。`/chat/completions` 那条本来就有，这次补上缺的一半。
- 给临时会话的建立和清理补了测试（之前 179 行核心逻辑零覆盖）。

## 0.4.4（2026-11-24）

「从客户端读取」这个登录方式之前是**完全失效**的，三个 bug 叠在一起。感谢 [@kunxiang1](https://github.com/kunxiang1) 在 [#16](https://github.com/miaocell/magpie-doubao-work-auth/issues/16) 里把根因和改法都定位到了行。

- **SQLite 内部页的子页号读错了。** 内部页的 cell 指针槽里存的是「页内偏移」，不是子页号；旧代码直接当子页号用，读到的全是垃圾页号，全被跳过 → 0 行。最右子页（`headerAt + 8`）也没读。结果是解析返回 0 行，上层报「该配置没有豆包登录会话」。实测同一个文件：修复前 0 行，修复后 300 行全读出。
- **profile 路径认不出客户端的真实布局。** 豆包工作把登录态放在 `User Data\aha\users\<hash>\profile_explorer\`，而 `resolveProfile()` 只接受 `Default` / `Profile N`，自动查找必然落空，用户只能手填路径。现在 `auto` 会去 `aha/users/*/profile_explorer` 找（多个时挑 Cookies 最新的），手填的名字也不再被正则拦。
- **v10 Cookie 的 host 摘要算错了。** Chromium 用的是数据库里原样的 `host_key`（`.doubao.com` 带点），旧代码去掉点再算，摘要对不上、32 字节前缀剥不掉，值变成「二进制 + 明文」的垃圾串，而且**不报错**，后面才表现为 Cookie 头非法。现在原样和去点两种都试。
- 补了一个真实 SQLite fixture 的回归测试（根页是内部页、300 行），这类布局之前完全没覆盖。

## 0.4.3（2026-11-21）

- **带工具的请求会记录耗时分解。** 用于排查「首字要等十几秒」的问题。实测一次带工具的请求：上游 6.5 秒才出第一块，但客户端要等到 19.7 秒——中间那 13 秒是插件自己造成的：带工具时必须收完整段才能解析工具调用，期间一个字都发不出去。现在超过 5 秒的请求会在日志里打出「上游首块 / 缓冲完成 / 总耗时」三项，便于确认影响面。行为暂时不变。

## 0.4.2（2026-11-21）

- **上游拒绝请求时会把脱敏后的请求体落盘**（来自 [@CGAdmin544](https://github.com/CGAdmin544) 的 [PR #11](https://github.com/miaocell/magpie-doubao-work-auth/pull/11)）。以前只能看到「400 参数错误」，不知道是哪部分撑大的。现在记录各部分体积（提示词 / 工具数 / 消息数），正文压成「长度 + 前 120 字」，Cookie 和 token 不进文件。放在 `%LOCALAPPDATA%\magpie-doubao-work-auth\diagnostics\`，自动保留最近 20 份。
- **风控冷却能提前解除**（同 PR #11）。之前被风控后会锁 5 分钟，用户即使在网页上过了验证，本地仍在拦、请求根本没发出去。现在冷却期内会用只读接口探一下服务端放没放行（最少间隔 30 秒），放行就提前恢复。文案也改了，不再说「过掉验证后立刻可用」。
- **超大请求的分级压缩**（同 PR #11）。请求体超过 100KB 时会分级压缩提示词和工具定义，每级都拼回完整 JSON，不做粗暴截断。这个阈值依据 issue #8 的实测（飞书免费账号，257KB / 290KB 被秒拒），对应用户是普通账号的真实情况。用 30 天体验账号测过 400KB~1.3MB 能正常出流，但体验号不代表普通账号，没据此放宽。

## 0.4.1（2026-11-20）

- **支持 Linux。** `os` 加上 `linux`，此前 Linux 装不上。Linux 上用「粘贴 Cookie」登录即可，对话、流式、工具调用、额度、签到都和 Windows 一致；浏览器登录和「从客户端读取」依赖 Windows / macOS 的安装路径，Linux 上走不通，登录菜单里直接不显示这两项。
- **非 Windows 的凭据改成真加密。** 以前 Linux / macOS 上保管库是明文落盘、只靠 `chmod 600`，README 却写着「不落明文」，说一套做一套。现在改成本地 key + AES-256-GCM，key 存在同目录的 `vault.key`（600）。旧版落的明文记录仍能读，下次保存自动转成密文。
- **模型菜单按账号类型走，不再固定 9 个。** 以前 `brief_list` 拿不到完整菜单就退回内置基线，所以订阅账号能用的 Qwen 那几档一直看不到。现在还会读 `/chat` 的 SSR 补齐，和基线取并集——订阅账号能出到 12 个（多出 Qwen 4 Max、Qwen 3.8 Max、Qwen 3.8 Flash），飞书账号仍是原本的 9 个（飞书没有 office 的 `model_list`，SSR 里只有 2 档）。
  「解析 SSR 补菜单」这个方向来自 [@GuiXunTaiYi](https://github.com/GuiXunTaiYi) 的 [PR #6](https://github.com/miaocell/magpie-doubao-work-auth/pull/6)，括号配对和多处 `modeSelectData` 的处理也参考了那份实现。解析之后的合并策略改成了并集——直接把 SSR 结果当模型表会让只有两三档的账号变少。
- **倍率解析放宽。** 倍率在服务端只是标签文案（`新上线 0.47x`），没有独立字段。原来只认结尾的 `0.47x`，现在中间的、带「倍」字的、全角数字、`×` 号都能读出来；读不出来时留空，不编一个数。
- **SSE 分帧认 CRLF 和单独的 CR。** 之前只按 `\n\n` 切事件、按 `\n` 切行，遇到 CRLF 行尾的上游会整段吞掉事件。规范允许 CRLF / LF / CR 三种，现在都认。
- **完整消息放在 `content` 里也能取到。** 上游有两种给法：直挂 `content_block`，或塞进 `content`（有时是 JSON 编码的块数组，有时是纯文本）。之前只认前者，整条消息会被丢掉。
- **设备上下文用真实值。** 之前 `fp` 是拿 `deviceId` 拼出来的假指纹（`verify_<id>`），服务端给的指纹有自己的结构，拼假的反更像脚本；现在直接用 Cookie 里的 `s_v_web_id`，拿不到就不发。`ttwid` 从 `launch` 取到后也真正随请求发送了（之前取了却没用上）。
- **额度能看出「赠送」和「活动卡」了。** 以前不读 `overview` 里的 `is_membership_gift`，有 30 天赠送订阅的账号看着像没订阅；也不读 `/alice/commerce/marketing/card/list/`，免费体验账号唯一有额度的地方（活动赠送卡）直接被跳过，界面显示「暂无额度」。现在套餐名会标「（赠送）」，活动卡单独成一条窗口。
- **额度上限不再被百分比吃掉。** 赠送套餐恒返回 `used_percent: 0` 且同时给出 `total_amount`/`used_amount`，旧代码先判百分比就永远走那个分支，界面上只剩「近 7 天 0」，看不到上限是 500。
- **风控提示对症。** `710022004` 的 `decision.subtype` 能区分原因：缺设备标识的提示去重新登录（去网页点验证没用），频次限制的提示停一会儿别重试，语义验证才提示去过验证码。以前一律说「去网页验证」，会把人引到错的方向。
- **「从客户端读取」不再要求手填目录。** 以前默认路径写死成 `%LOCALAPPDATA%\DoubaoWork\User Data`，但实测豆包工作有的版本装在 `Doubao` 这个目录名下，于是换了台电脑就找不到、只能自己翻路径。现在会把常见位置（Local / Roaming 下的 `Doubao` 和 `DoubaoWork`）挨个试一遍，留空即可；都找不到时报错会列出试过哪些位置，并给出自己确认路径的办法。
- 这是一次行为变化：Linux 可以装了（要重新安装插件），macOS 用户升级后保管库格式会变，旧记录读到时会自动迁移。
- **签到确认只能去豆包电脑版，插件不代签。** 曾经试过在 Web 会话下发领取请求，结果不只是签不上——失败的那次会消耗掉当天的额度（服务端表面状态不变，但客户端再点就提示「当前暂不符合领取条件」，当天作废、不可回滚）。现在插件只读状态，在额度卡片上显示今天签没签、连续几天、能领多少，并提示去电脑版领取。

## 0.3.4（2026-11-18）

- **工具回复带 Markdown 围栏或前后解释时也能解析。** 豆包有时把 JSON 包在 ` ```json ` 里，或前后加一句「好的，我来调用」，之前整段 parse 会失败。现在依次试围栏内、整段、首尾大括号之间三段。

## 0.3.3（2026-11-18）

- **工具回复被截断时不再作废整轮。** 模型偶尔中途停下，工具调用的 JSON 没闭合（长参数工具较常见），之前会直接报 `invalid_tool_response` 502，这一轮什么都没执行。现在会先尽量救回已经写完的工具调用，救不回来就把正文当普通回复返回（`finish_reason=stop`），让这一轮继续。客户端硬性要求必须调用工具时仍照实报错。

## 0.3.2（2026-11-18）

- **被风控拦下后不再反复重试。** 之前这种情况会被 magpie 当成「可换账号重试」，同一个请求连打 5 次，每次都撞在验证上，反而把风控状态越堆越高。现在风控错误会带上 `X-Magpie-Refused`，告诉 magpie 这是拒绝而不是可重试的失败，只失败一次。
- **风控冷却 5 分钟。** 收到人工验证要求后，5 分钟内不再向上游发请求，直接返回提示，避免客户端自动重试时持续撞线。
- **错误提示说清楚该怎么办。** 由 `rate limited` 这种容易误解的原文，改成「去 doubao.com/chat 手动发一句话过验证」。

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
