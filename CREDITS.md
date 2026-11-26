# 致谢

这个插件的很多改进来自别人的反馈和代码。按贡献类型列出，时间倒序。

## 代码贡献

| 贡献者 | 内容 | 相关链接 |
| --- | --- | --- |
| [@CGAdmin544](https://github.com/CGAdmin544) | 大 payload 的分级压缩、400 诊断落盘、风控冷却提前解除。诊断那部分尤其有用——之前 400 只能看到「参数错误」，完全不知道是哪部分撑大的 | [PR #11](https://github.com/miaocell/magpie-doubao-work-auth/pull/11) |
| [@GuiXunTaiYi](https://github.com/GuiXunTaiYi) | 「`brief_list` 拿不到菜单时改为解析 SSR」这个方向，括号配对和多处 `modeSelectData` 的处理也参考了他的实现。Linux 支持那三条阻塞点也是他提的 | [PR #6](https://github.com/miaocell/magpie-doubao-work-auth/pull/6) · [#7](https://github.com/miaocell/magpie-doubao-work-auth/issues/7) |
| [@MrUncleXiang](https://github.com/MrUncleXiang) | 工具回复被截断导致整轮 502 的诊断；他 PR 里兼容 Markdown 围栏和前后解释的 `extractToolJson` 已经合进主线 | [PR #5](https://github.com/miaocell/magpie-doubao-work-auth/pull/5) · [#4](https://github.com/miaocell/magpie-doubao-work-auth/issues/4) |

## 问题定位

| 贡献者 | 内容 | 相关链接 |
| --- | --- | --- |
| [@kunxiang1](https://github.com/kunxiang1) | 「从客户端读取」失效的三个根因，都定位到了具体行：SQLite 内部页的子页号读错、profile 路径不认识 `aha/users/<hash>/profile_explorer`、v10 Cookie 的 host 摘要算错。这三处让那个登录方式一直是坏的 | [#16](https://github.com/miaocell/magpie-doubao-work-auth/issues/16) |
| [@WeeZHnMin](https://github.com/WeeZHnMin) | 指出流式判定窗口对短回复是净损失，并给了「按首字符分流」的改法。还发现 `/responses` 那条路径没经过 `decodeReply`，工具调用会以裸 JSON 出现在正文里 | [#17](https://github.com/miaocell/magpie-doubao-work-auth/issues/17) |
| [@codetin](https://github.com/codetin) | 「首字 15-25 秒」的详细现象和日志，包括缓存全未命中的观察 | [#9](https://github.com/miaocell/magpie-doubao-work-auth/issues/9) |
| [@yufeng-liang](https://github.com/yufeng-liang) | 大 payload 触发 400 的完整体积拆解（会话 31KB + 工具 2.3KB + 系统提示词 257KB），比只说「400 了」好查太多 | [#8](https://github.com/miaocell/magpie-doubao-work-auth/issues/8) |
| [@notbesttime](https://github.com/notbesttime) | 上下文实际可用量和识图能力的实测数据 | [#10](https://github.com/miaocell/magpie-doubao-work-auth/issues/10) |
| [@hzw190](https://github.com/hzw190) | 指出 zcode 下看不到工作过程 | [#14](https://github.com/miaocell/magpie-doubao-work-auth/issues/14) |
| [@Andrew0767](https://github.com/Andrew0767) | 客户端登录识别不到、签到失败的反馈 | [#12](https://github.com/miaocell/magpie-doubao-work-auth/issues/12) |

## 其他反馈

| 贡献者 | 内容 | 相关链接 |
| --- | --- | --- |
| [@arsnyeon](https://github.com/arsnyeon) | 对话模式的需求；也提供了「这个接口是通的」这一关键信息 | [#3](https://github.com/miaocell/magpie-doubao-work-auth/issues/3) |
| [@weigram](https://github.com/weigram) | 测试报错反馈 | [#1](https://github.com/miaocell/magpie-doubao-work-auth/issues/1) |
| [@larchsis](https://github.com/larchsis) | 更新后登录被退出的反馈 | [#13](https://github.com/miaocell/magpie-doubao-work-auth/issues/13) |
| [@gan115](https://github.com/gan115) | 浏览器登录报错 | [#2](https://github.com/miaocell/magpie-doubao-work-auth/issues/2) |

## 竞品参考

排查过程中参考了两个同类项目的公开记录，有些结论（比如签到只能电脑版做、device_id 的作用、SSE 的几种缺陷）是从它们的 issue 和文档里先看到的：

- [3294798852/magpie-doubao-work](https://github.com/3294798852/magpie-doubao-work)
- [245678000000/magpie-doubaowork-auth](https://github.com/245678000000/magpie-doubaowork-auth)

---

如果漏了谁，或者上面的描述不准确，欢迎指出。
