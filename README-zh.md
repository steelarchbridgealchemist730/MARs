# Claude Paper

**不是写出更好论文的 AI，而是质疑得更好、证伪得更好、管理科学可信度更好的 AI。**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/FredFang1216/MARs/actions/workflows/ci.yml/badge.svg)](https://github.com/FredFang1216/MARs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@claude-paper/cli)](https://www.npmjs.com/package/@claude-paper/cli)

[English](README.md) | [中文](README-zh.md)

---

## 问题所在

现有的 AI 研究助手本质上都是高级写作机器人。给它们一个想法，就能生成一篇*看起来像*论文的东西——摘要、方法、实验、结论，格式完美、引用规范、行文流畅。但这不是研究，而是精巧的模仿。

真正的研究不是填模板。它是不断分解假设、寻找薄弱环节、设计最低成本的实验来证伪自己的想法。最优秀的研究者并不擅长"把故事讲圆"——他们擅长的是知道*故事在哪里还站不住脚*。

**Claude Paper 正是针对这个根本问题而生的。**

它不是论文生成器。它是一个完整的科学研究引擎——从文献调研到假设管理，从实验设计到定理证明，从论文撰写到同行评审——在每一步都像一个严肃的研究者那样思考。

---

## 核心理念

### 声明图，而非信念列表

大多数 AI 研究系统用扁平列表来跟踪进度："我相信 X，对 Y 不确定，Z 看起来有风险。"这就像用购物清单来管理一个复杂的工程项目。

Claude Paper 的核心数据结构是**声明图（Claim Graph）**——一个有向无环图，每个节点是一个科学论断，每条边是逻辑依赖关系。系统始终清楚：*如果这个论断倒了，哪些论断会跟着倒？*

每个论断被分配到四个**认知层级**之一：

| 层级 | 含义 | 示例 |
|---|---|---|
| **观察** | 我们看到了什么 | "在我们的硬件上，校准需要 30 秒" |
| **解释** | 我们如何解释它 | "校准慢是因为 SDE 参数敏感性" |
| **利用** | 我们据此构建了什么方法 | "神经算子完全绕过了 SDE 求解" |
| **论证** | 为什么这个方法是可靠的 | "万能逼近定理保证了可学习性" |

系统自动检测**层级跳跃**——当一个方法论断直接建立在观察之上，中间没有解释或论证的过渡。这是论文中最常见的逻辑缺口：看到一个现象，跳过机理理解，直接跳到算法设计。

### 三角色对抗循环：建设者、质疑者、仲裁者

每个推理循环在内部运行三个角色：

- **建设者（Builder）**追求最大化构建——提出最强版本的叙事，建议新实验，推动研究前进。*"我们还能主张什么？"*
- **质疑者（Skeptic）**追求最小化接受——寻找桥梁缺口，检查证据膨胀，计算某个论断失败时的级联损害。*"到底什么是站不住脚的？"*
- **仲裁者（Arbiter）**综合两方做出实际决策——哪些论断存活，哪些被降级，下一步做什么。

一个关键的工程决策：**建设者和质疑者刻意使用不同的 AI 模型。**同一个模型同时扮演两个角色意味着质疑者太容易被建设者的逻辑说服，使对抗过程流于形式。不同的模型确保了真正的智识张力。

这映射了真实科学的核心动态：**创造性扩展与证据约束之间的持续拉锯。**好的论文是这两种力量反复碰撞后的均衡产物。

在**探索模式**（`--exploratory`）下，对抗压力被放松：准入门槛降低，收敛目标更宽松，建设者被鼓励广泛探索而非严格证明。这适用于早期研究阶段，即你想先勘察全貌再确定具体方向的时候。

### 准入门：不是每个想法都配写进论文

一个硬编码的门控机制控制什么能进入论文。论断必须经过 `proposed -> under_investigation -> admitted` 的流程。这不是提示级别的建议（"请不要写无支撑的论断"），而是**代码级别的强制执行**：

- 完全没有证据 → 不能准入
- 定理类论断同时需要文献支撑（外部证据）和自己的证明（推导证据）
- 证据类型标为"一致"而非"支持" → 不能准入
- 依赖项尚未准入 → 你也不能准入

未通过门控的论断不会消失。它们被路由到讨论/局限性章节。这就是**边界收缩**——当证据不充分时，主动缩小论断范围，而不是硬撑叙事。诚实地声称"MS-GARCH 在点估计上最优但未达统计显著性"远比虚假地声称"MS-GARCH 显著优于所有基线"更有价值。

### 两类证据

受 UniScientist 论文启发，所有证据被分为：

- **外部证据（Grounded Evidence）**——来自外部来源的可独立验证的事实：论文中的定理、数据集的统计性质、已知的基准测试结果。
- **推导证据（Formally-Derived Evidence）**——来自你自己工作的结论：你证明的定理、你跑的实验、你做的统计检验。

一个稳健的核心论断应该**两类证据兼备**。系统持续追踪证据覆盖率——有多少核心论断同时拥有外部证据和推导证据？这是一个关键的收敛指标。

---

## 功能概览

- **深度文献研究** — 四阶段流水线（规划 → 发现 → 获取 → 索引），覆盖 arXiv、Semantic Scholar、SSRN，包含 PDF 提取和基于视觉模型的图表理解
- **提案生成** — 终端交互式浏览器，支持键盘导航、编辑、重新生成和新颖性检查
- **自适应编排器** — 不是固定流水线；Builder→Skeptic→Arbiter 循环基于声明图动态决定下一步行动
- **实验系统** — 分层执行（Tier 0 快速检查、Tier 1 探索性测试、Tier 2 发表级实验），隔离环境（uv/Docker/venv），静态 + 语义代码审计，每个实验自动生成 NOTE.md，汇总为 JOURNAL.md
- **写作管线** — 叙事规划（钩子 → 空白 → 洞见 → 方法 → 证据 → 细微之处），从片段写作章节，根据目标期刊/会议的页面预算排版，主图设计，多轮 LaTeX 编译自动修复
- **数学推理** — 与推理模型的多轮交互，基于定理重要性和期刊要求的证明预算控制（草图 → 半形式化 → 形式化）
- **同行评审** — 基于评审标准生成 15-25 个原子化、可客观验证的检查项，7 维评分，多审稿人并行执行，以最新文献为依据，未通过的检查项自动分派为修复任务
- **领域知识包** — 从教科书和论文中结构化提取知识（定理、定义、算法），构建关联图，可搜索索引，加载到智能体上下文中以支持基于已有成果的推理
- **探索模式** — `--exploratory` 标志用于预备性研究，放宽准入门槛，鼓励广泛探索
- **LaTeX 编译** — 基于规则的错误诊断辅以 LLM 兜底，最多 15 轮重试，支持多种期刊/会议模板（NeurIPS、ICML、AAAI、ACL、JFE、RFS）
- **论文交付** — 支持 arxiv（扁平 tar.gz）、camera-ready（去匿名化、加版权）和标准格式打包，自动生成复现脚本和 git 标签
- **Zotero 导入** — 从本地 Zotero 数据目录导入已有论文库
- **声明图查看器** — 全屏终端 UI，5 种模式（声明、详情、桥梁、准入、收缩），键盘导航

---

## 架构

```
src/paper/
├── orchestrator.ts              # 三角色（Builder→Skeptic→Arbiter）循环
├── claim-graph/                 # 带认知层级的声明有向无环图
│   ├── index.ts                 # ClaimGraph 增删改查、查询、级联分析
│   ├── types.ts                 # Claim, ClaimEdge, EpistemicLayer 类型
│   ├── context-views.ts         # L0/L1/L2 压缩用于上下文管理
│   ├── focus-selector.ts        # 按角色选择子图
│   └── prompt-assembler.ts      # 按角色构建提示词
├── admission-gate.ts            # 6 条确定性准入规则
├── evidence-pool.ts             # 外部 + 推导证据追踪
├── convergence.ts               # 4 分量收敛检测
├── research-state.ts            # 完整认知状态（可序列化）
├── deep-research/               # 4 阶段文献研究引擎
├── writing/                     # 叙事规划、章节写作、页数检查
│   ├── pipeline.ts              # 8 阶段写作编排
│   ├── narrative-planner.ts     # 从声明图提取研究故事
│   ├── figure-designer.ts       # 主图 + 主结果表设计
│   └── page-checker.ts          # 期刊/会议页数限制执行
├── experiment/                  # 分层实验运行器 + 环境隔离
├── domain-knowledge/            # 知识包构建、加载、索引
│   ├── pack-builder.ts          # 从教科书/论文构建知识包
│   ├── planner.ts               # 规划知识包结构
│   ├── entry-store.ts           # 知识条目增删改查
│   └── loader.ts                # 将知识包加载到研究上下文
├── review/                      # 基于评审标准的多审稿人系统
├── delivery/                    # 论文打包（arxiv/camera-ready/standard）
├── llm-client.ts                # 多模型路由（Claude + GPT）
├── math-reasoning-controller.ts # 多轮证明交互
├── fragment-store.ts            # LaTeX 片段管理
└── pdf-processor.ts             # PDF 文本 + 图像提取 + 视觉理解

agents/                          # 专用智能体的 LLM 提示模板
├── investigator.md              # 文献检索 + 验证
├── experiment-runner.md         # 代码生成 + 执行
├── result-analyzer.md           # 实验结果分析 + 图表
├── math-reasoner.md             # 定理证明
├── fragment-writer.md           # LaTeX 片段撰写
├── paper-assembler.md           # 片段 → 完整论文
├── latex-compiler.md            # LaTeX 编译 + 错误修复
├── reviewer.md                  # 7 维同行评审
├── revision-handler.md          # 审稿意见分类 + 修复
└── data-scout.md                # 数据可用性调查

templates/                       # 期刊/会议专用 LaTeX 模板
├── neurips/                     # NeurIPS 2026
├── icml/                        # ICML 2026
├── aaai/                        # AAAI 2026
├── acl/                         # ACL 2026
├── jfe/                         # Journal of Financial Economics
├── rfs/                         # Review of Financial Studies
└── custom/                      # 通用后备模板
```

### 上下文管理

一个中期研究项目序列化后可能超过 70,000 token。将全部内容塞入上下文会严重降低性能。

Claude Paper 采用受 LCM（无损上下文管理）启发的三层压缩系统：

- **L0**（约 300 token）：统计概览 — "50 个声明，18 个已准入，覆盖率 72%"
- **L1**（约 1,500 token）：关键声明 — 已准入骨架、三个最薄弱的桥梁、近期变更
- **L2**（约 2,000 token）：聚焦子图 — 只展开与当前决策相关的声明细节

每个角色看到**不同的子图**：建设者看前沿，质疑者看薄弱点，仲裁者看争议声明。这使每次 LLM 调用保持在 8,000-12,000 token——大多数模型的最佳区间。

### 模型分配

| 角色 | 默认模型 | 用途 |
|---|---|---|
| research | Claude Opus 4.6 | 建设者、仲裁者、深度研究、PDF 提取 |
| reasoning | GPT-5.4 | 数学证明、形式化验证（推理 token）|
| reasoning_deep | GPT-5.4 Pro | 需要深度推理的升级证明 |
| coding | Claude Opus 4.6 | 实验代码、系统任务 |
| writing | Claude Opus 4.6 | LaTeX 片段、论文组装 |
| review | GPT-5.4 | 质疑者阶段、同行评审 |
| quick | Claude Opus 4.6 | 轻量级任务 |

均可通过 `/settings` 或 `~/.claude-paper/config.json` 配置。

---

## 安装

```bash
# 前置条件：Bun (https://bun.sh)，LaTeX 发行版（编译时可选）

git clone https://github.com/FredFang1216/MARs.git
cd MARs
bun install

# API 密钥
export ANTHROPIC_API_KEY="your-key"
export OPENAI_API_KEY="your-key"        # 用于推理/评审模型
export S2_API_KEY="your-key"            # 可选，用于 Semantic Scholar

# 构建并运行
bun run build
./cli.js

# 或直接以开发模式运行
bun run dev
```

## 快速开始

```bash
# 在 Claude Paper CLI 内：

# 1. 首次运行设置向导
/onboarding

# 2. 深度文献研究
/deep-research "你的研究主题"

# 3. 生成并浏览研究提案
/propose

# 4. 启动编排器（自适应研究循环）
/run

# 5. 早期探索（放宽严格度）
/run --exploratory

# 6. 从教科书构建领域知识
/knowledge build stochastic-calculus --from shreve-vol2.pdf

# 7. 撰写论文（叙事规划 → 章节写作 → 编译）
/write

# 8. 运行同行评审
/review --strength thorough --reviewers 3

# 9. 查看声明图
/view

# 10. 打包提交
/deliver --format arxiv
```

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `/deep-research <topic>` | 四阶段文献研究，带实时进度界面 |
| `/propose` | 生成研究提案 + 交互式浏览器 |
| `/run` | 启动/恢复自适应编排器循环 |
| `/auto <topic>` | 全自动模式：研究 → 提案 → 实验 → 论文 → 评审 → 交付 |
| `/do <description>` | 强制编排器执行指定动作 |
| `/next` | 显示编排器建议的下一步动作 |
| `/view` | 全屏声明图查看器（5 种模式：声明、详情、桥梁、准入、收缩）|
| `/status` | 研究状态概览（声明、收敛度、预算）|
| `/papers search\|read\|ask` | 查询本地文献数据库（PaperQA）|
| `/experiment` | 实验管理（设计、状态、恢复、中止）|
| `/write` | 撰写论文：叙事规划 → 章节写作 → LaTeX 编译 |
| `/fragments` | 管理 LaTeX 片段（列表、查看、创建）|
| `/review` | 多审稿人同行评审，可配置评审强度 |
| `/deliver` | 打包论文 + 代码以供提交（arxiv/camera-ready/standard）|
| `/knowledge` | 构建、加载和管理领域知识包 |
| `/template` | 管理 LaTeX 期刊/会议模板（列表、切换、安装）|
| `/zotero-import` | 从本地 Zotero 库导入论文 |
| `/settings` | 交互式配置面板 |
| `/system-check` | 检测系统能力（GPU、LaTeX、Python 等）|
| `/onboarding` | 首次运行设置向导 |
| `/cost` | Token 用量和费用明细 |

---

## 实验系统

实验拥有完整的生命周期管理，分三个层级：

- **Tier 0**：10 秒级数值验证（"alpha+beta 等于多少？"）
- **Tier 1**：探索性测试（"用 100 天数据试试 GARCH 参数"）
- **Tier 2**：发表级实验（"完整的多模型对比 + 统计检验"）

每个实验获得隔离的 `uv` 虚拟环境，依赖锁定、种子固定、结果可复现。代码审计分两层：静态审计（lint、单元测试、数据泄漏检查）和语义审计（LLM 检查基线是否公平、评估协议是否正确）。Tier 2 实验必须通过审计才能执行。

每个实验自动生成结构化记录（**NOTE.md**）：为什么要跑这个实验（哪个循环的仲裁者决定的，质疑者挑战了什么） → 做了什么 → 审计结果 → 结果表格 → 解读 → 下一步。所有记录汇总到研究日志（**JOURNAL.md**）。

执行前进行资源评估——GPU、内存、磁盘和运行时间需求将与可用硬件进行比对。OOM 错误触发自动缩小批量大小并重试。

## 写作管线

论文写作不是简单的"生成文本"。它遵循结构化管线：

1. **叙事规划** — 从声明图中提取研究故事：钩子（为什么读者应该关心？）、空白（缺少什么？）、洞见（我们发现了什么？）、方法、证据、细微之处。生成逐章节计划，页面预算拟合目标期刊/会议要求。
2. **章节写作** — 每个章节从其叙事计划出发，利用研究过程中已产出的片段（证明、实验描述、表格）来撰写。各章节是独立的 LaTeX 文件。
3. **图表设计** — 设计一张主图（一幅抓住核心贡献的精炼图示）和主结果表，根据目标期刊/会议的尺寸要求从实验数据中生成。
4. **组装** — 复制期刊/会议模板，注入所有章节的 `\input{}` 指令，同步参考文献。
5. **编译** — 使用 `latexmk` 编译，配合基于规则的错误诊断。常见问题（缺少宏包、未定义命令、引用错误）自动修复；顽固错误交给 LLM 诊断。最多 15 轮重试。
6. **页数检查** — 如果编译后的 PDF 超过期刊/会议页数限制，智能建议并执行内容削减。

## 评审系统

评审不是模糊的"可靠性 7/10"。系统从声明图生成 15-25 个**原子化、可客观验证的检查项** — "MS-GARCH 在 DM 检验中对比 GARCH 是否达到 p<0.05？"是有效的检查项；"方法论是否严谨？"则不是。

每位审稿人对 7 个维度评分：原创性、重要性、可靠性、清晰度、可复现性、与先前工作的对接、贡献。评审以最新文献为依据——审稿人可访问项目的论文数据库。未通过的检查项自动成为修复任务，分派给相应的智能体。

可通过参数配置：`--strength`（light/standard/thorough/brutal）、`--reviewers`（并行审稿人数量）、`--grounded`（强制文献支撑）。

## 领域知识包

领域知识包（DKP）允许你从教科书和论文中提取结构化知识——定理、定义、算法、命题——转化为可搜索、可引用的格式。

```bash
# 从教科书 PDF 构建知识包
/knowledge build stochastic-calculus --from shreve-vol2.pdf

# 加载到当前研究会话
/knowledge load stochastic-calculus

# 查看可用知识包
/knowledge list
```

每个知识包包含带有形式化表述、前提假设、证明概要和引用信息的条目。关联图链接相关条目（依赖关系、泛化关系）。加载后，智能体可以搜索知识包，基于已建立的成果进行推理，而非重新推导或凭空编造。

---

## 配置

Claude Paper 通过 `~/.claude-paper/config.json` 和 `/settings` 命令进行配置。

主要配置项：
- **模型分配** — 各角色（research、reasoning、coding、writing、review）使用哪个 LLM
- **论文设置** — 模板、编译器（pdflatex/xelatex/lualatex）、语言、最大页数、目标期刊/会议
- **文献** — 数据源 API、arXiv 分类、最大论文数、年份范围、引用阈值
- **实验** — Python 版本、GPU 要求、最大运行时间、自动重试设置
- **评审** — 审稿人数量、最大修改轮数、接受阈值
- **预算** — 总 USD 上限、预警百分比

## 开发

```bash
bun install              # 安装依赖
bun run build            # 生产构建（esbuild → dist/）
bun run dev              # 开发模式运行

bun test                 # 运行所有测试
bun test tests/unit      # 仅单元测试
bun test tests/e2e       # 仅端到端测试

bun run lint             # eslint（零警告）
bun run lint:fix         # eslint 自动修复
bun run format           # prettier 格式化
bun run format:check     # 检查格式
bun run typecheck        # tsc --noEmit
```

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解规范。简而言之：在功能分支上工作，推送前运行 `bun run format:check && bun run typecheck && bun test && bun run build`，CI 通过后方可合并。

---

## 它代表着什么

Claude Paper 不试图取代研究者。它试图将**研究方法论本身**形式化为一个可执行的系统。

> **一个 AI 研究助手的质量，不在于它能产出多么精美的论文，而在于它能多么诚实地管理"我们已知的"与"我们尚不能声称的"之间的边界。**

当 AI 学会在写散文之前先分解论断、在列亮点之前先找断裂点、在扩展之前先证伪、在证据不足时收缩论断——它就开始在*做科学*，而不仅仅是在*模仿科学的外表*。

---

## 许可证

Apache 2.0 — 参见 [LICENSE](LICENSE)。

基于 ShareAI Lab 的 [Kode-Agent](https://github.com/shareAI-lab/Kode)，经全面重写以支持自主学术研究。

## 作者

Fred Fang — [lei.fang@maths.ox.ac.uk](mailto:lei.fang@maths.ox.ac.uk)

## 链接

- [报告问题](https://github.com/FredFang1216/MARs/issues)
- [讨论区](https://github.com/FredFang1216/MARs/discussions)
