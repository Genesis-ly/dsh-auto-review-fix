# dsh-auto-review-fix

[English](README.md) | **中文**

修复官方 Auto review 集成（`@deepseek-ai/dsh-experimental-auto-review`）的**入口侧**缺陷：审阅者一旦失败，`tools/pre-execute` 抛异常 → 整条工具通道被 fail-closed 拦死（连 `echo hi` 都过不去）。

> 状态：**P1 可用（v0.2.0）**，27 条单测覆盖分支。不改官方包，随官方更新仍生效。

## 三个真实故障源（本机日志取证）

从 45 个会话中扫出 **86 条**被拦的工具结果，归为三类：

| # | 报错 | 取证 | 根因 |
|---|---|---|---|
| A | `auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block` | `provider=custom-route model=DeepSeek-V4.1-Flash tools=101 hasTool=true` | 审阅调用**复用主请求的 provider**；该第三方路由不遵守审阅协议（吐多段文本/普通正文），形状校验必失败。`Unexpected token 'I'`（把主会话正文当裁决）同源 |
| B | `auto-review: reviewer ended with error STREAM_CLOSED: …` | `provider=deepseek-account model=deepseek-flash` | 上游流式偶发中断，集成**不重试** |
| C | `auto-review: the pending native tool schema is missing or ambiguous` | `provider=deepseek-account … tools=142 hasTool=false` | `session.requestHeader()` 可能指向非对话请求（标题/压缩）的 header，工具不在其中 → 快照构造失败 |

A、B 都能在 LLM 调用层修；C 在调用层之前就抛了，只能靠兜底。

## 修复机制

挂两个钩子（都是服务包装，**不修改 vendor 文件**，插件更新后依然生效）：

1. **审阅路由：会话优先，失败才回退**（wrap `ctx.llm.stream`）
   - 只识别带固定审阅系统提示（含 `You are the final authorization reviewer`）的调用，其它请求原样透传。
   - **第一次尝试完全沿用调用参数**，也就是会话当前配置的 provider/model —— 审阅者与主会话用同一个模型。
   - 每次尝试都按集成本身的验收标准预检：必须有终止 `finish`、必须是 `stop`、必须是"零个或多个 reasoning 块 + 恰好一个 text 块"、且 text 块能通过封闭的 risk/decision 协议。不满足即视为该路由"不可用"。
   - 会话路由不可用时，才把 provider/model 换成固定回退路由（默认 `deepseek-account` / `deepseek-flash`）重试一次。`retries` 可让主路由多试几次再回退。
   - 全部尝试失败才抛错，错误信息保留最后一次真实原因，交给闸门兜底。
2. **闸门兜底**（prepend `tools/pre-execute`）
   - 我们排在集成之前（`prepend` 后注册先运行），因此能包住它的异常。
   - 只接管 `auto-review:` 前缀的异常 → 按 `fallback` 返回决定，**默认 `ask`**（走正常审批弹窗，你点一次就放行），而不是把工具调用变成失败。
   - 其它插件的异常原样抛出，不吞。

审计（每次路由回退、每次闸门兜底各一行）：`~/.dsh/dsh-auto-review-fix/audit.jsonl`。

## 配置

```yaml
- id: dsh-auto-review-fix
  config:
    enabled: true
    route: session                   # session = 会话当前模型（默认）；fixed = 固定用下面两项
    # provider: deepseek-account     # 仅 route: fixed 时生效
    # model: deepseek-flash
    fallbackProvider: deepseek-account  # 仅当会话路由不可用时使用；空字符串 = 关闭回退
    fallbackModel: deepseek-flash
    retries: 0                       # 主路由额外尝试次数，0 = 失败即回退
    fallback: ask                    # 全部失败后：ask | allow | deny
    auditPath: '~/.dsh/dsh-auto-review-fix/audit.jsonl'
```

`inheritRoute` 仍被接受为旧别名（`true` → `route: session`，`false` → `route: fixed`）。

`fallback` 取舍：

- `ask`（默认）：保留人工闸门，审阅坏了就弹审批，最安全；
- `allow`：无人值守场景，审阅坏了直接放行（**会绕过审查**，仅在你自己可控的机器上用）；
- `deny`：保守失败，等价于现在的"全拦"，但报错信息更清楚。

## 安装

```powershell
# 完全退出 DSH（含托盘）后
pwsh -NoProfile -File .\scripts\install.ps1    # 在本包目录执行
```

## 验证

1. **装载**：重启后 Host 日志出现 `dsh-auto-review-fix: review route the session route, fallback deepseek-account/deepseek-flash, retries 0, gate fallback ask, stream hook on`。
2. **会话路由生效**：把会话切到「自动审查」，让 agent 执行一条普通命令 → 正常执行；会话日志里的审阅请求 provider/model 与会话一致，不再出现 `reviewer must emit` / `Unexpected token`。
3. **回退生效**（可选，人为制造）：把 `fallbackProvider` 改成一个不存在的值，再让会话用一条不遵守审阅协议的路由 → `audit.jsonl` 出现 `"kind":"route-fallback"`，工具照常执行。
4. **兜底生效**（可选）：把 `fallbackProvider` 置空并让会话路由不可用 → 工具不是失败，而是弹出审批；`audit.jsonl` 出现 `"kind":"gate-fallback"`。
5. **回归**：普通对话请求不受影响（可用任意模型照常对话），说明只改了审阅调用。

## 回滚

profile patch 里 `enabled: false`（或从 `dsh.profile.bundles` 移除 `dsh-auto-review-fix`），重开即恢复原行为。插件只包装服务，卸载即还原。

## 已知边界

- 会话路由若**每个**审阅都不可用（例如第三方推理路由总吐正文），每次工具调用都会先失败一次再回退 —— 多一次模型请求。想省掉这次浪费就把 `route` 设为 `fixed`。
- 回退路由**假定** `deepseek-account/deepseek-flash` 可用；若该账号无额度/未登录，回退也会失败 → 退到 `fallback`。此时把 `fallbackProvider`/`fallbackModel` 改成任一能稳定输出 JSON 的路由即可。
- 兜底只认 `auto-review:` 前缀错误，集成若改用别的措辞需同步更新 `isAutoReviewError`。
- `ask` 兜底在审批策略为 `never` 的会话里会被确定性拒绝（DSH 语义），但那类会话本来也不跑审阅。
- 不修复 C 的根因（`requestHeader()` 选错 header），只把它的后果从"全挂"降级为"弹一次审批"（C 在 `llm.stream` 之前抛出，路由层够不到）。
