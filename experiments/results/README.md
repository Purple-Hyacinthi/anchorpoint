# Lab 原始报告归档

各轮 headless lab 的原始 JSON 报告（`run-lab.mjs` 输出的 `results.json`）。
每个元素是一个会话：`{ preset, run, report }`，`report` 含 persona、第 1 请求工具表、
catalog@step、首段 reasoning 全文摘录与 we/weNeed/letMe 计数。

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| `lab-results-v3.json` | v3 硬指令桥首轮 4 次（中文编程题 `写个 sort.py 排三行文本`，skills 变体） | 4/4 首段以 "We need to" 开场 |
| `lab-ab-v2-results.json` | A/B 组 A：v2（框架+反导语）4 次同题 | 2/4（两条锚定，两条 "The user wants a sort.py…"） |
| `lab-ab-v3-results.json` | A/B 组 B：v3（硬指令）4 次同题 | 4/4 |

更早的英文任务 5+5 轮 lab（`lab-results.json`）在清理 lab 目录时一并删除，其结论记录在
`experiments/METHOD.md` 的"2026-08-16 本机实测"一节（skills 变体 3/5 "We need"、
standard 0/5）。

生成方式见 `experiments/METHOD.md` 第二步；所有会话均为真实计费运行。
