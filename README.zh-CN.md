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

## 三层渐进式接入

按团队需要按需开启，不强制一步到位：

| 层级 | 包含内容 | 适用场景 | 接入成本 |
| --- | --- | --- | --- |
| **Tier 1：纯 Skill + 模板** | `skills/featflow/SKILL.md` + `features/_template.md` | 快速建立“先探索 -> 出计划 -> 等确认 -> 记录交接”的协作规范 | ~1 分钟 |
| **Tier 2：CLI + Git Hooks** | `featflow init / worktree / finish / cleanup / pr-cleanup` + `.githooks/` | 多 worktree 并行开发、合并后自动清理、保护分支防呆 | ~3 分钟 |
| **Tier 3：Agent Hooks 硬门禁** | `featflow hook <codex\|claude-code> ...` | 在工具调用层拦截“计划未填完/未审批就改源码”与高危命令 | ~5 分钟 |

---

## 快速开始

### 方式 A：只安装 Agent Skill（Tier 1）

```bash
npx skills add https://github.com/daniel-style/featflow --skill featflow
```

### 方式 B：完整接入 Skill + CLI + Hooks（Tier 2 & 3）

```bash
# 在项目中安装（或 npm i -g 全局安装）
npm install -D github:daniel-style/featflow

# 初始化（默认 trunk 模式，适合个人/小团队/开源项目）
npx featflow init --with-githooks

# 或初始化为团队个人开发分支模式（main <- dev <- <dev> <- <prefix>/<dev>-<task>）
npx featflow init --mode developer-branch --with-githooks

# 可选：同时生成 Codex 或 Claude Code 的 Agent Hooks 配置
npx featflow init --with-codex-hooks --with-claude-hooks
```

随后把 [`templates/snippets/AGENTS-workflow.md`](./templates/snippets/AGENTS-workflow.md) 中的精简规则粘贴到项目的 `AGENTS.md` 或 `CLAUDE.md` 中即可。

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
| `featflow init` | 生成 `.featflow.json`、`features/` 模板、`.agents/skills/featflow/SKILL.md` 及可选 Git/Agent Hooks。 |
| `featflow setup [branch]` | 初始化个人开发分支（`developer-branch` 模式）并安全配置 Git hooks。 |
| `featflow status` | 查看当前模式、分支状态、所有 worktree、进行中/暂停中的 feature 记录和下一步建议。 |
| `featflow worktree <branch>` | 为任务分支创建独立 worktree，并自动执行 `.featflow.json` 中配置的 `postWorktreeCreate` 命令。 |
| `featflow finish <branch>` | 完成并收尾任务分支（合并/推送、自动切出待删 worktree、移除干净 worktree 与本地分支）。支持 `--no-push`、`--pr`、`--dry-run`、`--keep-worktree`、`--keep-branch`。 |
| `featflow cleanup` | 清理已合入目标分支且工作区干净的本地任务分支与 worktree（也挂在 `post-merge` 钩子自动执行）。 |
| `featflow pr-cleanup <pr>` | GitHub PR 合并后（依赖 `gh` CLI）同步目标基线分支、删除干净 worktree 与本地/远端分支并 prune。 |
| `featflow plan-check [path]` | 校验当前 active feature 记录的 `Plan Details` 章节完整度、占位符清理与审批状态。 |
| `featflow policy <pre-commit\|pre-push>` | Git hooks 保护分支拦截（一次性初始化可用 `FEATFLOW_BOOTSTRAP=1` 放行）。 |
| `featflow hook <codex\|claude-code> <event>` | 面向 Codex 与 Claude Code 的 `pre-tool-use` / `user-prompt` / `stop` Hook 适配器。 |
| `featflow doctor` | 体检 Git、配置、模板、Skill、Hooks 与当前 feature 计划状态。 |

---

## 关键工程细节

- **绝不覆盖已有 Husky / Lefthook**：检测到 `core.hooksPath` 已被其他工具占用时不会粗暴覆盖，而是提示如何把单行 `featflow policy ...` 接入现有钩子。
- **消除 `current-feature.md` 合并冲突**：默认忽略 `features/current-feature.md`，用 `features/active/` 作为多 worktree 唯一真源；需要共享指针时可加 `--track-pointer`。
- **支持记录不入库（本地模式）**：不希望把 AI 规划文档提交进 Git 历史？运行 `featflow init --local-features` 即可将 `features/` 写入 `.gitignore`，同时保留完整的规划校验与 worktree 自动化。
- **更精准的 `PreToolUse` 校验**：区分只读命令（`rg`、`cat`、`git diff`）与真实写操作，检测占位符前自动剥离 Markdown 代码块与行内代码避免误拦，且校验 `Pre-Implementation Approval` 非 `pending`。
- **可扩展的 `postWorktreeCreate` 钩子**：需要在建完 worktree 后自动装依赖（如 `pnpm install --frozen-lockfile --offline`）或构建索引（如 `codegraph init`），直接配置到 `.featflow.json` 的 `postWorktreeCreate` 数组即可。

---

## 本地测试

```bash
npm run smoke
npm test
```

## 开源协议

[MIT](./LICENSE)
