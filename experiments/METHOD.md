# 复现 "We need" 锚定的方法与组件（实验室版）

一句话原理：V4 Pro 的第 1 个请求如果与官方 Minimal preset 完全一致（Minimal 系统提示词
`You are a helpful software engineer assistant.` + 真实 Minimal 工具对 `bash`/`str_replace_editor`
+ **不注入** 技能目录与 AGENTS.md 摘要 + adapter 默认 maxTokens），会话就会锚定在
"We need …" 推理轨迹上；而 `<available_skills>` 目录一旦进入第 1 个请求，锚定几乎必然失败
（issue #6：在场 0/9，摘掉后 ~81%）。本项目做的事是：**把技能目录的第一次出现推迟到
锚定完成之后**，而不是放弃技能。

## 组件清单（本仓库）

| 组件 | 作用 |
| --- | --- |
| `preset/` | 主 preset：无目录注入，改用 `skill_search`/`skill_load` 按需加载技能 |
| `anchored-standard-skills/` | 技能变体：保留官方 `dsh-tool-skill`（`skill` 工具、`/skill` 手势、目录全可用），目录被推迟到 promotion 之后 |
| `preset/skill-catalog-deferred.mjs` | 目录注入的 preset 自有兜底（官方监听器身份检查在某些挂载下失败时的逐字节等价替代） |
| `preset/skill-home-provider.mjs` | 权限无关的用户技能根 provider：用 `node:fs` 直读 `<DSH_HOME>/skills` 与 `~/.agents/skills`，绕开被沙箱 fs 门控的官方发现（详见下文"权限独立性"） |
| `preset/tool-bootstrap.mjs` 的 CJK 桥 | 首请求检测到汉字时把 `zhBridgeText` 合并进首条 user 消息，把中文任务的首段推理拉回 "We need" 锚定（详见下文"语言效应与桥迭代"）；`bridgeTrace: true` 可写一次性诊断 trace |
| `experiments/preset-runner.mjs` | 给 headless 加"挂载 preset"能力的小插件（headless 原生不挂 preset） |
| `experiments/session-report.mjs` | 解压并解析会话 JSONL：第 1 请求工具表、persona、目录进入步数、"we/let me" 计数 |
| `experiments/run-lab.mjs` | 一键实验室：复制隔离 DSH_HOME → 装 preset → 逐 preset 跑同一任务 → 出对比表 |

## 前置条件

- DeepSeek Harness `0.1.0-rc.5+`（实测 rc.6），Node ≥ 22.15（`node:zlib` 自带 zstd）
- 一个配好的 v4-pro 路由（本仓库实验用 `settings.yaml` 里的 xyit / deepseek-v4-pro，`reasoningEffort: max`）
- Windows。Linux 用户把 `run-lab.mjs` 里 `'junction'` 换成 `'dir'` 即可（预设本身跨平台）

## 第一步：安装 preset（正式使用）

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/preset"
test ! -e "$dsh_home/.agent-presets/anchored-standard-skills"
cp -R preset                    "$dsh_home/.agent-presets/preset"
cp -R anchored-standard-skills  "$dsh_home/.agent-presets/anchored-standard-skills"
```

注意：变体之间通过 `../preset/...` 相对行共享插件模块，所以共享目录**必须**以其原名
`preset` 存在（它会作为一个额外的 user preset 出现在列表里，无害）。重启 DSH，新建空白会话，
选 **Anchored Standard + Skills (experimental)**。

## 第二步：一键实验（两条命令）

```powershell
# DSH_BIN 指向当前 DSH 的启动入口；DSH_HOME 用当前真实 home
$env:DSH_BIN = 'C:\...\node_modules\@deepseek-ai\dsh\lib\bin.js'
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
node experiments\run-lab.mjs --presets anchored-standard-skills,standard --runs 1
```

脚本会：复制一份隔离的 `.dsh`（排除 sessions，不动真实 home，可和正在跑的 `dsh web` 并存）→
重连 profiles 的 junction → 安装两个 preset → 给 headless 换 preset-runner → 对每个 preset
各跑一个新会话（同一任务）→ 打印对比表并把原始结果写到 `lab-run/results.json`。

可选参数：`--runs N`（每个 preset 跑 N 次）、`--task "中文任务"`、`--lab <目录名>`
（默认 `lab-run`）、`--bridge-text "..."`（只在 lab 副本的 yml 里覆盖 CJK 桥文本，
不动仓库默认值——A/B 对比不同桥版本时用它）。

两个注意：
- 实验室继承**源 home 的模型路由与凭据**（`.credentials.yaml` 会被复制进去；如果密钥来自
  环境变量而非文件，请先 `export` 好再跑）。跑完删除 `lab-run/`。
- 脚本用 `DSH_BIN` 指向的启动入口起子进程，`DSH_HOME` 必须是当前真实 home。

## 第三步：怎么读结果

| 列 | 说明 | 锚定成功的标志 |
| --- | --- | --- |
| persona | 第 1 请求系统提示词 | `minimal-complete`（即 Minimal 原文） |
| #tools req#1 | 第 1 请求 API 可见工具数 | `2`（bash + str_replace_editor） |
| catalog@step | 技能目录第一次进入的步数 | `never` 或 `step 2+`（skills 变体） |
| "we" / "we need" | 第 1 段 reasoning 里的计数 | 高，且 reasoning 以 "We need …" 开头 |
| "let me" | 标准轨迹标志 | 0 或极低 |

对照 `standard` 预设：`#tools` 25、`catalog@step` 1、reasoning 开头通常是
"The user wants me to …"（`let me` 风格）。

## 手动验证（不跑实验脚本）

在 GUI 里用 skills 变体开一个空白会话，随便让它干一件小活，然后导出会话 JSONL 检查：

1. 第 1 个 `request/header` 的 `tools` 恰好是 `["bash","str_replace_editor"]`；
2. 第 1 个请求的消息里没有 `skill-catalog` 与 `agent-instructions`；
3. 第 2 个请求起 `skill` 出现在工具表里，`<available_skills>` 目录恢复注入；
4. 第 1 段 reasoning 以 "We need …" 开头。

## 费用与限制

- 每跑一个新会话 = 一次真实模型计费；`--runs 1` 足够做机制演示。
- 这是**机制演示**，不是统计结论。仓库 README 的 5/5、26/32 等数字来自
  [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) 的 N≥5 方案，要复现统计学结论按那个跑。
- 别把 `session-report.mjs` 解压出的 `.jsonl` 写回会话目录（后端会因压缩模式不符拒绝）。
- headless 原生不挂 agent preset（web 网关通过 `dsh-host-apiproxy` 挂），所以实验必须用
  `preset-runner.mjs` 替换 stock runner——这一步只影响实验进程，不动正式 GUI。

## 2026-08-16 本机实测（xyit / deepseek-v4-pro / reasoningEffort=max）

同任务（写 sort.py 排序三行文本）、同线路、各一个新会话，headless + preset-runner：

| | persona | #tools req#1 | req#1 消息 | catalog@step | reasoning 首行 |
| --- | --- | --- | --- | --- | --- |
| `anchored-standard-skills` | minimal-complete (46) | 2 = bash + str_replace_editor | user only | **step 2** | A10 "We need respond to user." / A11 "We need to do tasks: …" / A4、A12 "The user wants me to:" |
| `standard` | harness-identity (4577) | 26 | user + runtime + skill-catalog | step 1 | "The user wants me to:" (we=0, let me=2) |

机制结论（每次运行都成立）：**第 1 请求 = Minimal 精确条件 ⇒ 锚定窗口打开；目录推迟到
第 2 步（而非删除）⇒ 技能目录/工具全程可用。** 但 "We need" 首行本身是**每会话随机**
（4 次中 2 次），单次 A/B 不是测量——要统计结论就 `--runs 5` 起跑并用
[modeltest](https://github.com/xiaobright/modeltest) 的口径报"锚定率"。

headless 诊断过程中的两个挂载发现（均已写入实现）：
1. **YAML 行位置不是加载顺序**（loader 并发应用行），"把 skill 插件挪到最后"必须实现为
   相位门：`tool-bootstrap` 的 strip 只在未 promotion 时剥 `skill-catalog` 源，目录从
   step 2 起恢复。
2. **官方目录监听器在多层同名注册下失效**：`dsh-tool-skill` 目录监听器带
   `ctx.tools.get('skill', agent) === skillTool` 身份检查；base 层也有 `skill` 注册时
   （headless 实测）它静默永不注入（工具与 /skill 手势不受影响），禁掉 base 行后恢复。
   所以变体自带 `skill-catalog-deferred.mjs` 兜底注入（与官方渲染逐字节一致、按 digest
   去重，官方生效时自动 no-op）。

## 2026-08-16 补充实测：权限独立性、语言效应与桥迭代

### 1. 注入依赖 Full Access 的根因与修复（"强依赖 danger-full-access"）

官方 `dsh-skill-filesystem` 用**沙箱 fs** 读用户技能根。权限模式低于
danger-full-access 时（如 workspace-write）读取失败 → provider 整体被注册表跳过 →
`snapshot.complete=false` 且候选为空 → 兜底器里的 `if (!snapshot.complete) return`
静默放弃注入。症状：**目录注入只有在 Full Access 下才出现**。

修复（两处）：
- `preset/skill-home-provider.mjs`：新增 provider，用 `node:fs` 直读两个固定用户技能根
  （`<DSH_HOME>/skills`、`~/.agents/skills`）。根是固定的、模型不可控，不越沙箱边界；
  rank 350/450 在预设层内压过官方 400/500，同层同名优先；`list`/`get` 都实现，
  `skill` 工具加载与 `skill_search`/`skill_load` 同步受益。
- `skill-catalog-deferred.mjs` 删除 `!snapshot.complete` 早退闸：只要存在可用候选就注入，
  仅空目录跳过。

实测：workspace-write 下目录照常 step 2 注入、技能照常加载（GUI 会话日志确认）。

### 2. 锚定窗口的语言效应

同样的 Minimal 条件（46 字符 persona + 2 工具 + 纯 user 首请求）下：
- **英文任务**：首段推理涌现 "We need to …"（headless lab 3/5）；
- **中文任务**：首段推理被翻译导语吃掉（`The user is speaking Chinese: …`，GUI 4/4）——
  模型必须先理解任务，而理解过程消耗了锚定窗口，等翻译完 "We need" 的开场机会已过。

机制层（persona/工具/注入卫生）与语言无关；字面 "We need" 锚定最初只在英文任务上涌现。

### 3. CJK 桥 v1→v3 迭代

首请求检测到汉字时把桥文本合并进首条 user 消息（`zhBridgeText`，`""` 关闭）：

| 版本 | 内容 | 实测 |
| --- | --- | --- |
| v1 纯框架 | `We need to fulfill the request below. (The user wrote in Chinese — reply in Chinese.)` | 未真正执行（见第 5 节缓存陷阱）；早期"1/3"是误归因 |
| v2 反导语 | v1 + `Do not open your reasoning with a restatement or translation of the request; start directly with the plan.` | **A/B 2/4**：两条锚定，两条以 "The user wants a sort.py…" 开场 |
| v3 硬指令 | v2 + `Begin your reasoning with a sentence that starts with "We need to" describing the work ahead;` | **lab 4/4 + A/B 4/4 + GUI 实测 1/1 = 9/9** |

结论：中文编程任务上，反导语条款约一半概率被无视；显式 "We need to" 开场指令是必需的。
最终桥文本：

> We need to fulfill the request below. (The user wrote in Chinese — reply in Chinese.)
> Begin your reasoning with a sentence that starts with "We need to" describing the work
> ahead; do not open with a restatement or translation of the request.

### 4. user-approval 启动通知剥离

宿主审批栈在会话启动把策略从默认 ask 切到 never 时会注入一条一次性通知
（`source: { kind: 'plugin', plugin: 'user-approval' }`）。空白会话里它是纯噪音，
且会污染第 1 请求。修复：`suppressedContextSources` 默认加入 `plugin:user-approval`
（`kind:plugin` 组合匹配，精确到单个插件），bootstrap 阶段剥掉；会话中途真实切换
策略时（已 promotion）通知仍会到达模型。

### 5. live 进程的 ESM 模块缓存陷阱（重要）

DSH 进程按**文件 URL** 缓存已加载的预设模块（原生 `import()` 缓存），组合代际只跟踪
组合 yml 的 stamp。**进程不重启时，对已加载 `.mjs` 的任何修改都不会生效**，而
`standingKeyFor` 挂载验证照样返回成功——它验证的是"旧模块 + 新 yml"的组合。

实害案例：v1/v2/v3 三轮"已部署"全部无效，GUI 全部失败、headless lab（全新进程）
却 4/4，一度被误判为"GUI 与 headless 行为差异"。铁证：给 yml 加 `bridgeTrace: true`
后挂载直接报 `unknown config key(s) bridgeTrace`，而错误里的允许键列表连 `zhBridgeText`
都没有——磁盘文件明明已含这些键。

规则：**修改已加载的预设模块时必须给文件改名**（如 `tool-bootstrap-live.mjs`）并更新
行引用（新 URL → 强制新导入）；或者等进程重启后再改。仅改组合 yml 不需要改名。
`bridgeTrace: true`（写 `<DSH_HOME>/bridge-trace.jsonl`）就是为此而生的诊断：pre-step
组装不可持久化，trace 是证明"哪个版本真的在跑"的唯一途径。仓库默认关闭。

### 6. 实验数据归档

`experiments/results/` 下保存各轮 lab 的原始报告（JSON）：
- `lab-results-v3.json`：v3 桥首轮 4 次（中文编程题 4/4 锚定）
- `lab-ab-v2-results.json` / `lab-ab-v3-results.json`：v2 vs v3 A/B（2/4 vs 4/4）
- 更早的英文任务 5+5 轮 lab 原始文件已随清理删除，结论见"2026-08-16 本机实测"节。

