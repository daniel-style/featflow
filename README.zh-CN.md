# featflow

**面向 AI 编程的工程化特性工作流：Skill + CLI + Git / Agent Hooks。**

[English README](./README.md)

`featflow` 为人类开发者和 AI Coding Agents（Codex、Claude Code、Cursor、Antigravity 等支持 Agent Skills 的工具）提供一套经过高频实战打磨的闭环工作流：

1. **先只读探索（Discovery）**：改代码和建分支前，先读清真实代码、契约与测试。
2. **先出方案并等待审批（Pre-Implementation Gate）**：任何写操作之前输出具体方案，获批后再动手。
3. **任务级 Git Worktree 隔离**：每个需求/修复独立分支与独立目录，多任务并行互不干扰。
4. **结构化 Feature & Program 记录**：在 `features/` 下沉淀需求 brief、详细实现计划、决策与验证结果，跨会话/长周期项目随时可恢复。
5. **程序化硬护栏**：通过 Git Hooks 与可选的 Agent Hooks（`PreToolUse` / `UserPromptSubmit` / `Stop`），真正拦截保护分支误写和“计划没填完就改产品代码”。

零第三方运行时依赖，纯 Node.js ESM（`>=20`），支持 macOS / Linux / Windows。

---

## 灵活接入（推荐全局安装，按项目按需选档）

**不需要每个项目都内置依赖或拷模板！** 本机全局安装一次后，每个仓库可以按实际情况选择侵入程度：

| 模式 | 目标仓库改动 | 适用场景 |
| --- | --- | --- |
| **1. 纯全局零入侵（推荐）** | **0 个文件**（`featflow new --local` 用内置模板写到 `.featflow/features/` 并写入 `.git/info/exclude`；`featflow hooks install --local` 装在 `.git/hooks/`） | 个人项目、Python/Go/Rust 等非 JS 项目、给外部开源项目提 PR |
| **2. 轻量一键接入（`featflow init --minimal`）** | **`.featflow.json` + `AGENTS.md` 托管块 + 本地 `.git/hooks/`**（不动 `package.json`、不拷模板和 Skill 目录） | 多仓库开发者，全局装一次 CLI 后在任意项目一条命令配齐自动探测配置与工作流规则 |
| **3. 团队项目内置（`devDependency`）** | `package.json` + `.featflow.json` + `AGENTS.md` 托管块 + 同步的 Skill/模板/`.githooks/` + CI `featflow sync --check` | 多人协作 JS/TS 仓库，希望新人 `pnpm install` 零额外步骤且 CI 强锁版本 |

---

## 快速开始

### 方式 A：全局安装（推荐，跨所有项目与语言通用）

```bash
# 1. 本机全局安装一次 CLI（也可通过 GitHub tag 安装：github:daniel-style/featflow#v0.6.3）
npm install -g featflow

# 2. 本机全局安装一次 Agent Skill（Codex / Claude Code / Cursor / Antigravity 自动识别）
npx skills add https://github.com/daniel-style/featflow --skill featflow -g
```

在**任意** Git 仓库里立即可用（0 文件入侵）：

```bash
# 可选：在 .git/hooks/ 启用本地保护分支与自动清理钩子（不改仓库任何 tracked 文件）
featflow hooks install --local

# 创建隔离任务 worktree
featflow worktree feat/oauth-pkce

# 用内置模板生成 feature 计划记录（--local 存本地并自动写入 .git/info/exclude）
cd ../my-repo-worktrees/feat-oauth-pkce
featflow new oauth-pkce --local

# 验证并 commit 后，一键合并收尾并清理 worktree
featflow finish feat/oauth-pkce
```

想在一个新项目或已有项目里一条命令完成自动探测（主干/保护分支、源码目录、测试命令）、注入 `AGENTS.md` 托管块并启用本地钩子，同时不拷冗余模板、不动 `package.json`？直接运行：

```bash
featflow init --minimal
```

### 方式 B：多人 JS/TS 项目内置锁定版本

```bash
npm install -D featflow

# 交互式初始化向导：TTY 下带多选勾选框，手动勾选护栏模块和要安装的 Agent Hooks
npx featflow init

# 或者一条命令直接开启全家桶（600 行代码限制 + pre-commit 兜底 + 回归守卫 + Issues 闭环 + 四大 Agent Hooks）：
npx featflow init --preset full --yes

# 已有项目无损升级（保留原配置，只增量合并新 hooks / 回归账本 / 自动生成历史行数基线）：
npx featflow init --merge --with-all-hooks --with-regression
```

`featflow init` 默认会用 `<!-- FEATFLOW_START --> ... <!-- FEATFLOW_END -->` 托管块无损写入项目的 `AGENTS.md` / `CLAUDE.md`（可用 `--no-agent-docs` 跳过），后续升级可通过 `featflow sync` 一键同步。

---

## 支持的两种分支模式

### 1. `trunk` 模式（默认：个人 / 小团队 / 开源项目）

```text
main (保护分支)
  ├── feat/oauth-pkce          (独立 worktree)
  └── fix/retry-timeout        (独立 worktree)
```

- `featflow worktree feat/oauth-pkce` 从 `main` 拉出分支并建好 `../<repo>-worktrees/feat-oauth-pkce`。
- `"finishTarget": "merge"`（默认）：`featflow finish feat/oauth-pkce` 合并回 `main`、有远端则推送（可用 `--no-push` 仅本地），并自动删掉干净的 worktree 和任务分支。
- `"finishTarget": "pr"`（或命令加 `--pr`）：`featflow finish feat/oauth-pkce --pr` 推送任务分支供提 PR；合并后执行 `featflow pr-cleanup <pr-number>` 同步 `main` 并清理本地环境。

### 2. `developer-branch` 模式（多人高频协作团队）

```text
main (发布分支，受保护)
  └── dev (团队集成分支，受保护)
        ├── alice (个人长期开发分支)
        │     ├── feat/alice-oauth-pkce     (任务 worktree)
        │     └── fix/alice-retry-timeout   (任务 worktree)
        └── bob (个人长期开发分支)
```

- 每个本地克隆首次执行一次：`featflow setup alice`（基于 `origin/dev` 创建/跟踪 `alice`，写入 `git config featflow.developerBranch alice`，并安全启用 hooks）。
- 日常任务从 `alice` 分叉，命名为 `<prefix>/alice-<task>`（不要用 `alice/...`，因为 Git 不允许同名分支与命名空间前缀并存）。
- `featflow finish feat/alice-oauth-pkce` 合回并推送 `alice`，清理干净的任务 worktree 与本地分支，**绝不直接改动 `dev` 或 `main`**。
- 需要团队集成（`alice -> dev`）或发布（`dev -> main`）时再显式提 PR。

---

## 常用 CLI 命令

| 命令 | 说明 |
| --- | --- |
| `featflow new <slug>` | 使用项目模板或 `featflow` 内置模板新建 feature（或 `--program`）记录，自动填入时间戳、`owner` 与分支；加 `--local` 存到 `.featflow/features/` 并写入 `.git/info/exclude` 实现零入侵。 |
| `featflow hooks <install\|uninstall\|status>` | 管理 Git hooks：`--local`（默认）在 `.git/hooks/` 中无损增删托管块，保留已有自定义 hook 且不改仓库文件；`--repo` 生成入库的 `.githooks/`。 |
| `featflow init` | 自动探测项目配置、无损注入 `AGENTS.md`/`CLAUDE.md` 托管块，并在 TTY 下提供方向键/空格多选勾选框让用户勾选护栏模块和四大 Agent Hooks。支持 `--preset full`（一键全家桶）、`--minimal`、`--merge`（老项目无损增量升级并自动生成历史行数基线）、`--agent-hooks <antigravity,claude-code,codex,cursor\|all\|none>` 与 `--yes`。 |
| `featflow sync` | 从当前安装的 `featflow` 同步更新 Skill、模板、`.githooks/` 与 `AGENTS.md`/`CLAUDE.md` 托管块，不改动 `.featflow.json`、已有记录及托管块外的自定义文档。支持 `--check` 放进 CI 防漂移、`--only skill,templates,githooks,agent-docs` 按需同步。 |
| `featflow setup [branch]` | 初始化个人开发分支（`developer-branch` 模式）并安全配置 Git hooks。 |
| `featflow status` | 查看当前模式、分支状态、所有 worktree、进行中/暂停中的 feature 记录和下一步建议。 |
| `featflow worktree <branch>` | 为任务分支创建独立 worktree，并自动执行 `.featflow.json` 中配置的 `postWorktreeCreate` 命令。 |
| `featflow finish <branch>` | 完成并收尾任务分支（合并/推送、自动切出待删 worktree、移除干净 worktree 与本地分支）。支持 `--no-push`、`--pr`、`--dry-run`、`--keep-worktree`、`--keep-branch`。 |
| `featflow issue <subcommand>` | 可选的 GitHub Issues 闭环 CLI（`create` / `list` / `view` / `claim` / `review` / `release` / `labels:sync`，仅在调用时依赖 `gh`）。认领前先预检本地 worktree 再改远端状态，支持通过 `.featflow.json` 的 `issues.assetsRepo` 托管截图，并可通过 `featflow init --with-issues` / `featflow sync` 同步可选 `featflow-issues` Skill。 |
| `featflow size-check [options]` | 可选的多语言文件行数预算守卫（支持历史基线只减不增棘轮、`--changed`、`--update-baseline`、`--json` 及 `post-tool-use` 即时拦截），通过 `.featflow.json` 的 `fileSizeBudget` 按需启用。 |
| `featflow regression <impact\|check\|validate>` | 可选的回归守卫账本 CLI（支持 YAML/JSON 账本）：按改动文件检索命中的历史 Bug 不变量、运行守卫命令或校验账本完整性，配套可选 `featflow-regression` Skill。 |
| `featflow verify [options]` | 按改动文件匹配执行 `.featflow.json` 中的 `verifyCommands`（支持 `--all`、`--with-size`、`--with-regression`、`--dry-run`、`--json`）。 |
| `featflow codegraph [bootstrap\|status]` | 一键初始化或同步本地 `.codegraph/codegraph.db` 索引（CI 环境或未装 CLI 时静默跳过）。 |
| `featflow cleanup` | 清理已合入目标分支且工作区干净的本地任务分支与 worktree（也挂在 `post-merge` 钩子自动执行）。 |
| `featflow pr-cleanup <pr>` | GitHub PR 合并后（依赖 `gh` CLI）同步目标基线分支、删除干净 worktree 与本地/远端分支并 prune。 |
| `featflow plan-check [path]` | 校验当前 active feature 记录的 `Plan Details` 章节完整度、占位符清理与审批状态。 |
| `featflow policy <pre-commit\|pre-push>` | Git hooks 护栏：拦截保护分支直提交/直推送，以及 `enforceInPreCommit: true` 时拦截超出 `fileSizeBudget` 的暂存文件（一次性放行可用 `FEATFLOW_BOOTSTRAP=1` / `FEATFLOW_SKIP_SIZE_CHECK=1`）。 |
| `featflow hook <antigravity\|claude-code\|codex\|cursor> <event>` | 通用 AI Coding Agent Hook 适配器，原生支持 Antigravity（`.agents/hooks.json`）、Claude Code（`.claude/settings.json`）、OpenAI Codex（`.codex/config.toml`）与 Cursor（`.cursor/hooks.json`）。 |
| `featflow doctor` | 体检 Git、配置、模板、Skill、Hooks 与当前 feature 计划状态。 |

---

## 关键工程细节

- **绝不覆盖已有 Husky / Lefthook**：检测到 `core.hooksPath` 已被其他工具占用时不会粗暴覆盖，而是提示如何把单行 `featflow policy ...` 接入现有钩子。
- **消除 `current-feature.md` 合并冲突**：默认忽略 `features/current-feature.md`，用 `features/active/` 作为多 worktree 唯一真源；需要共享指针时可加 `--track-pointer`。
- **支持记录不入库（本地模式）**：不希望把 AI 规划文档提交进 Git 历史？运行 `featflow init --local-features` 即可将 `features/` 写入 `.gitignore`，同时保留完整的规划校验与 worktree 自动化。
- **更精准的 `PreToolUse` 校验**：区分只读命令（`rg`、`cat`、`git diff`）与真实写操作，检测占位符前自动剥离 Markdown 代码块与行内代码避免误拦，且校验 `Pre-Implementation Approval` 非 `pending`。
- **可扩展的 `postWorktreeCreate` 钩子**：需要在建完 worktree 后自动装依赖（如 `pnpm install --frozen-lockfile --offline`）或构建索引（如 `codegraph init`），直接配置到 `.featflow.json` 的 `postWorktreeCreate` 数组即可。
- **多仓库一键同步防漂移**：在业务仓库升级 `featflow` 后运行 `featflow sync` 即可同步最新 Skill、模板与 `.githooks/`，不会覆盖项目自身的 `.featflow.json`；把 `featflow sync --check` 放进 CI 可自动防止文档/模板与 CLI 版本脱节。

---

## 本地测试

```bash
npm run smoke
npm test
```

## 开源协议

[MIT](./LICENSE)
