# Harness 优化测量报告（2026-07-27）

对应改动：上游 PR [can1357/oh-my-pi#6793](https://github.com/can1357/oh-my-pi/pull/6793)，
issue [#6786](https://github.com/can1357/oh-my-pi/issues/6786)，
实现分支 [`feat/mcp-dedupe-prompt-budget`](https://github.com/alloevil/oh-my-pi/tree/feat/mcp-dedupe-prompt-budget)。

## 改动清单

| # | 改动 | 类型 | 默认 |
|---|---|---|---|
| 1 | MCP server 按连接身份去重（stdio: command+args+env+cwd；http/sse: url+headers），优先保留无冒号名；最终工具名碰撞确定性 keep-first + warning | bug fix | 自动生效 |
| 2 | `skills.promptDescriptionMaxChars` — system prompt `<skills>` 列表描述截断（句界感知，ASCII+CJK，代理对安全） | opt-in 设置 | 0（关） |
| 3 | `tools.xdevTopLevelDevices` — glob 命中的 discoverable 工具保持顶层原生挂载，消除 xd:// 读文档→写调用往返 | opt-in 设置 | []（关） |

## 测量结果

### 改动 2：skill 描述预算（本机 26 个 lark skill，全中文长描述）

同一环境、同一工具集，`buildSystemPrompt` 渲染两次，仅 cap 不同：

| 指标 | cap 关 | cap 120 | 节省 |
|---|---|---|---|
| 完整 system prompt | 20436 字符 | 17226 字符 | **3210 字符（-15.7%）/每次请求** |
| `<skills>` 列表本身 | 5584 字符 | 2374 字符 | -57% |

CJK 约 1 字符 ≈ 1 token，即每次请求省约 2-3k token；子代理各自渲染 prompt，同样受益。
截断样例（句界切割，路由语义完整）：

> 把本地 HTML 文件或目录部署到飞书妙搭（Miaoda），生成一个公网可访问的应用及其链接（URL）。当用户要创建 HTML 或要把 HTML、静态网站或 Web demo 发布成公网可访问的链接 /…

**追加（同日）— brief 模式**：新增 `skills.promptDescriptionMode: "brief"`（渲染 frontmatter `summary`，无则取描述首句）+ skill frontmatter `summary` 字段。同一环境对照：

| 模式 | system prompt 字符 | 相对全文 |
|---|---|---|
| full / 不截断 | 20436 | — |
| full / cap 120 | 17226 | -15.7% |
| **brief** | **16203** | **-20.7%** |

brief 优于纯 cap 且切割语义更干净（首句即作者的路由主句，无列举中断）。cap 可叠加在 brief 之上。

### 改动 1：MCP 去重

- 设备清单减少 2 条重复路由（`mcp__context_context_query_docs` / `mcp__context_context_resolve_library_id`），实际会话对比确认消失。
- 每会话少拉起一个 `npx @upstash/context7-mcp` stdio 子进程（npx 冷启动延迟 + 一份 node 进程内存）。
- 附带发现：本机的两个 context7 是不同传输（插件 stdio 版 vs `mcp.context7.com` HTTP 版），属配置冗余而非别名重复，已通过 `~/.omp/agent/mcp.json` 的 `disabledServers: ["context7:context7"]` 禁用 stdio 版。

### 改动 3：xd:// 置顶

未启用（`[]`），收益 = 命中次数 × 每次省一整轮模型往返。启用依据见下方持续测量。

## 复现方法

```bash
# prompt 尺寸对照（在 repo 根目录）
bun -e '
const B = "./packages/coding-agent";
const { buildSystemPrompt } = await import(`${B}/src/system-prompt`);
const { loadSkills } = await import(`${B}/src/extensibility/skills`);
const { skills } = await loadSkills({ cwd: process.env.HOME + "/Downloads" });
for (const cap of [0, 120]) {
  const { systemPrompt } = await buildSystemPrompt({
    cwd: process.env.HOME + "/Downloads", skills,
    skillsSettings: { promptDescriptionMaxChars: cap },
    toolNames: ["read","bash","edit","write","grep","glob","task","todo","ask","web_search"],
    contextFiles: [], rules: [],
  });
  console.log(cap, systemPrompt.join("\n\n").length);
}'

# MCP 去重验证
bun -e '
const { loadAllMCPConfigs } = await import("./packages/coding-agent/src/mcp/config");
console.log(Object.keys((await loadAllMCPConfigs(process.cwd())).configs));'

# 契约测试（49 项）
cd packages/coding-agent && bun test test/mcp-mount-dedupe.test.ts test/prompt-budget-controls.test.ts \
  test/system-prompt-inventory.test.ts test/mcp-server-tool-ownership.test.ts \
  test/issue-5764-registertool-loadmode.test.ts
```

## 持续测量（下一步）

- `omp stats`：改动前后各一周的 token 消耗 / cache 读写对比 — 端到端裁决指标。
- `omp bench --cache`：prompt 缩小对 cache 写成本的影响。
- 会话 JSONL 统计 xd:// 往返频次，决定 `tools.xdevTopLevelDevices` 置顶名单：
  `grep -o '"xd://[^"]*"' ~/.omp/sessions/**/*.jsonl | sort | uniq -c | sort -rn | head`

## 待办优化池

~~3. natives napi 构建封装吞 stderr~~ ✅ 已修：错误现带 exit code + stderr/stdout 截尾段。
issue [#6796](https://github.com/can1357/oh-my-pi/issues/6796)、PR [#6797](https://github.com/can1357/oh-my-pi/pull/6797)

~~4. `check:rs` 在干净 checkout 上即红~~ ✅ 已修：pinned rustfmt 重排 `crates/vendor/uu-sort`。
PR [#6798](https://github.com/can1357/oh-my-pi/pull/6798)

~~5. skill 语义路由（过渡态）~~ ✅ 已做 brief 模式 + `summary` frontmatter（并入 PR [#6793](https://github.com/can1357/oh-my-pi/pull/6793)）。完整语义路由（意图命中才展开）仍开放。

仍开放：

1. `sanitizeMCPToolNamePart` 剥数字（`context7`→`context`）— 有损折叠的另一半根源，改动需迁移考量
2. `disabledServers` 缺 CLI（应有 `omp mcp list/disable/enable`）
3. skill 完整语义路由（一行摘要常驻 + 意图匹配命中才展开全文）
4. 子代理并发编辑合并 diff 可见性
5. 多文件事务性 edit（原子提交/回滚）
6. verify 原语（把 smoke test 从纪律变机制）
