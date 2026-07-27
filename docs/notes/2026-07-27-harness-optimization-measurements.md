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

## skill 路由质量评测（brief 模式的收益/风险量化）

成本侧（token）好测，真正的问题是质量侧：brief 会不会让模型选错 skill。方法：**离线路由 A/B**。

**方法**（可复现，~100 次模型调用，几分钟）：
1. 对 26 个 skill，各由模型从 SKILL.md **正文**生成 2 条真实用户请求（1 典型 + 1 口语化；不照抄描述原句，避免偏向任一变体）→ 52 条评测集。
2. 同一模型作为路由器：给定 `<skills>` 列表（full / brief 两个变体）+ 请求，schema 约束只回一个 skill 名。
3. 对比 top-1 准确率；错例逐条分析。

**结果**：

| 变体 | 列表字符 | 准确率 |
|---|---|---|
| full | 6041 | 52/52 = 100% |
| brief（初版） | 1808 | 51/52 = 98.1% |
| brief + 2 条 summary | 1851 | **52/52 = 100%** |

**唯一错例及其修复回路**（方法论的核心发现）：
- 错例：「把 Excel 导入飞书变成多维表格」→ 应选 lark-drive，brief 选了 lark-base。
- 根因有两半：lark-base 的 brief 切掉了排除规则「文件导入转 lark-drive」；**且 lark-drive 自己的首句也丢了「导入」能力**。只补前者不够（5/5 仍错）——排除规则敌不过对面条目的吸引力缺失。
- 修复：给两个 skill 各写一条 frontmatter `summary`（把排除规则/关键能力写进一行），5/5 转正，全量回归 52/52。
- 结论：`summary` 字段不是装饰——它是 brief 模式的质量保障机制，错例驱动地补 summary 即可收敛。

**在线持续量化**（离线过关后的下一层）：
- 纠错信号：一次请求内连续读 2+ 个 `skill://`（第一次选错才需要第二次）——会话 JSONL 可直接统计频次。
- `omp stats` 周对比：每任务总 token、轮次。
- 判定标准：纠错率不升 + token/任务下降 = 净收益成立。

局限：n=52、单模型、评测查询由模型生成（非真实用户日志）；置信区间宽，1 个错例的差距不具统计显著性——但错例分析的价值不依赖显著性（它暴露的是机制性缺陷，且修复可验证）。

## 追加：弱模型 + 真实上下文的修正实验

初版评测的两个方法缺陷（评审指出）：路由器用了强模型（会用自身知识补偿劣质描述）；上下文只有裸列表 2k 字符（真实场景列表埋在 ~20k 的完整 system prompt 里）。修正：路由器换 claude-haiku-4-5（scout/子代理档），system prompt 用 buildSystemPrompt 的真实完整渲染，2×2 矩阵。

| haiku-4-5 | full | brief |
|---|---|---|
| 裸列表 | 94.2% | 96.2% |
| 真实 20k prompt | 96.2%（run2: 92.3%） | 90.4% → **治愈后 92.3%** |

发现：
1. **强模型确实掩盖退化**（fable-5 全场 100%）；弱模型 + 稀释上下文才暴露 brief 初版 -5.8pp。
2. **简短本身无罪**：裸列表下 brief 反而高于 full。损失全部来自个别条目丢失判别线索，稀释放大之。
3. brief 特有错例全是近邻技能混淆（sheets↔base、slides↔doc、会议汇总↔vc）。补 3 条 summary 后修复 2 个。
4. **对照跑揭示噪声底线**：real×full 两跑 96.2% / 92.3%（±2 题），治愈后 brief 与 full run2 同分且错例 3/4 重合；有 3 条查询在多数格子均错（评测集本身歧义）。结论：**治愈后 brief 与 full 在弱模型+真实上下文下无可分辨差异**，残差是评测噪声。
5. 方法论修正：单跑不作数，每格 ≥3 跑；评测集需人工复核歧义标签；错例驱动补 summary 是收敛回路。

当前共 5 条 summary（lark-base、lark-drive、lark-sheets、lark-slides、lark-workflow-meeting-summary），brief 列表 1900 字符 vs full 6041。
