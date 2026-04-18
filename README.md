# Qwen Claude Code 插件

> [!NOTE]
> 本插件参考 codex-plugin-cc 版本 v1.0.3 进行开发。

[English](./README.md) | [中文](./README_zh.md)

在 Claude Code 中使用 Qwen 进行代码审查或将任务委托给 Qwen。

本插件适用于想要在现有工作流程中便捷使用 Qwen 的 Claude Code 用户。

## 功能特性

- `/qwen:review` 用于标准的只读 Qwen 代码审查
- `/qwen:adversarial-review` 用于可引导的质疑性审查
- `/qwen:rescue`、`/qwen:status`、`/qwen:result` 和 `/qwen:cancel` 用于任务委派和后台任务管理

## 环境要求

- **阿里云百炼 API Key 或 Qwen Code 账号**
  - 使用此插件需要配置 API Key。[查看配置文档](https://help.aliyun.com/zh/model-studio/qwen-code)。
- **Node.js 20 或更高版本**

## 安装

请前往官网查看安装说明：

[https://qwen.ai/qwencode](https://qwen.ai/qwencode)

然后运行：

```bash
/qwen:setup
```

`/qwen:setup` 会告诉你 Qwen Code 是否已准备就绪。如果缺少 Qwen Code,它可以为你安装。

如果你想自己安装 Qwen Code,使用：

```bash
bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)"
```

如果已安装 Qwen Code 但尚未配置,运行：

```bash
!qwen login
```

安装完成后,你应该看到：

- 下方列出的斜杠命令
- `/agents` 中的 `qwen:qwen-rescue` 子代理

一个简单的首次运行测试：

```bash
/qwen:review --background
/qwen:status
/qwen:result
```

## 使用说明

### `/qwen:review`

对当前工作运行标准的 Qwen 代码审查。它提供的审查质量与直接在 Qwen 中运行 `/review` 相同。

> [!NOTE]
> 多文件变更的代码审查可能需要较长时间。通常建议在后台运行。

适用于以下场景：

- 审查当前未提交的变更
- 审查你的分支与基础分支(如 `main`)的差异

使用 `--base <ref>` 进行分支审查。它也支持 `--wait` 和 `--background`。该命令不可引导,不接受自定义焦点文本。当你想质疑特定决策或风险区域时,使用 [`/qwen:adversarial-review`](#qwenadversarial-review)。

示例：

```bash
/qwen:review
/qwen:review --base main
/qwen:review --background
```

此命令是只读的,不会执行任何变更。在后台运行时,你可以使用 [`/qwen:status`](#qwenstatus) 检查进度,使用 [`/qwen:cancel`](#qwencancel) 取消正在进行的任务。

### `/qwen:adversarial-review`

运行**可引导的**审查,质疑所选的实现和设计。

可用于检验假设、权衡、失败模式,以及是否存在更安全或更简单的替代方案。

它使用与 `/qwen:review` 相同的审查目标选择,包括使用 `--base <ref>` 进行分支审查。
它也支持 `--wait` 和 `--background`。与 `/qwen:review` 不同,它可以接受标志后的额外焦点文本。
结构化输出现已强化为 JSON-only 约束：JSON 前后不允许附加说明文本，也不允许使用 ```json 这类 Markdown 代码块包裹。

适用于以下场景：

- 发布前希望挑战方向而不仅仅是代码细节的审查
- 专注于设计选择、权衡、隐藏假设和替代方案的审查
- 围绕特定风险领域(如认证、数据丢失、回滚、竞态条件或可靠性)进行压力测试

示例：

```bash
/qwen:adversarial-review
/qwen:adversarial-review --base main 挑战缓存和重试设计是否是正确的选择
/qwen:adversarial-review --background 寻找竞态条件并质疑所选方法
```

此命令是只读的。它不会修复代码。

### `/qwen:rescue`

通过 `qwen:qwen-rescue` 子代理将任务委托给 Qwen。

适用于以下场景：

- 调查 bug
- 尝试修复
- 继续之前的 Qwen 任务
- 使用较小的模型进行更快速或更经济的尝试

> [!NOTE]
> `/qwen:rescue` 现在默认前台执行。只有在你明确希望任务脱离当前会话长时间运行时,才使用 `--background`。

它支持 `--background`、`--wait`、`--resume` 和 `--fresh`。如果省略 `--resume` 和 `--fresh`,插件可以提议继续此仓库的最新救援线程。

示例：

```bash
/qwen:rescue 调查测试为何开始失败
/qwen:rescue 用最小的安全补丁修复失败的测试
/qwen:rescue --resume 应用上次运行的顶部修复
/qwen:rescue --model qwen-plus --effort medium 调查不稳定的集成测试
/qwen:rescue --model qwen-turbo --effort low 快速修复问题
/qwen:rescue --background 调查回归问题
```

你也可以直接要求将任务委派给 Qwen：

```text
让 Qwen 重新设计数据库连接以提高弹性。
```

**注意：**

- 如果不传递 `--model` 或 `--effort`,Qwen Code 会使用自己的默认值。
- 后续的救援请求可以延续仓库中最新的 Qwen 任务
- 如果不传递 `--background`,`/qwen:rescue` 会在前台等待,并直接返回 Qwen 的输出

### `/qwen:status`

显示当前仓库中运行和最近的 Qwen 任务。

示例：

```bash
/qwen:status
/qwen:status task-abc123
```

用于：

- 检查后台工作进度
- 查看最新完成的任务
- 确认任务是否仍在运行

### `/qwen:result`

显示已完成任务的最终存储输出。
可用时,还会包含 Qwen 会话 ID,你可以使用 `qwen resume <session-id>` 直接在 Qwen 中重新打开该次运行。

示例：

```bash
/qwen:result
/qwen:result task-abc123
```

### `/qwen:cancel`

取消活动的后台 Qwen 任务。

示例：

```bash
/qwen:cancel
/qwen:cancel task-abc123
```

### `/qwen:setup`

检查 Qwen Code 是否已安装和配置。
如果缺少 Qwen Code,它可以为你安装。

你也可以使用 `/qwen:setup` 管理可选的审查关卡。

#### 启用审查关卡

```bash
/qwen:setup --enable-review-gate
/qwen:setup --disable-review-gate
```

启用审查关卡后,插件会使用 `Stop` 钩子基于 Claude 的响应运行定向的 Qwen 审查。如果审查发现问题,则会阻止停止,以便 Claude 先处理这些问题。

> [!WARNING]
> 审查关卡可能会创建长时间运行的 Claude/Qwen 循环,并可能快速消耗使用限额。仅在计划主动监控会话时启用它。

## 典型工作流

### 发布前审查

```bash
/qwen:review
```

### 将问题交给 Qwen

```bash
/qwen:rescue 调查 CI 中构建失败的原因
```

### 启动长时间运行的任务

```bash
/qwen:adversarial-review --background
/qwen:rescue --background 调查不稳定的测试
```

然后通过以下方式检查：

```bash
/qwen:status
/qwen:result
```

## Qwen 集成

Qwen 插件封装了 Qwen Code CLI。它使用环境中安装的全局 `qwen` 二进制文件,并应用相同的配置。

运行时同时兼容旧版 ACP `session/*` 方法和新版 Qwen Code 使用的 `thread/*` + `turn/*` 方法。

### 常用配置

查看 Qwen Code 文档了解更多[配置选项](https://help.aliyun.com/zh/model-studio/qwen-code)。

### 将工作转移到 Qwen

委派的任务和任何[审查关卡](#审查关卡的作用)运行也可以直接在 Qwen 中恢复,通过运行 `qwen resume`,可以使用从 `/qwen:result` 或 `/qwen:status` 收到的特定会话 ID,或从列表中选择。

这样你可以审查 Qwen 的工作或在那里继续工作。

## 常见问题

### 我需要为此插件使用单独的 Qwen Code 账号吗？

如果你已在此机器上登录 Qwen Code,该账号也应该可以立即在这里使用。此插件使用你本地的 Qwen Code CLI 认证。

如果你今天只使用 Claude Code 且尚未使用 Qwen Code,你还需要使用阿里云百炼 API key 登录 Qwen Code。运行 `/qwen:setup` 检查 Qwen Code 是否已准备就绪,如果未准备,使用 `!qwen login`。

### 插件是否使用单独的 Qwen 运行时？

不。此插件通过同一台机器上的本地 [Qwen Code CLI](https://help.aliyun.com/zh/model-studio/qwen-code) 进行委派。

这意味着：

- 它使用与你直接使用相同的 Qwen Code 安装
- 它使用相同的本地认证状态
- 它使用相同的仓库检出和机器本地环境

### 它会使用我已有的 Qwen 配置吗？

是的。如果你已经使用 Qwen Code,插件会读取相同的[配置](#常用配置)。

### 我可以继续使用当前的 API key 或基础 URL 设置吗？

可以。因为插件使用你本地的 Qwen Code CLI,你现有的登录方法和配置仍然适用。

如果需要将提供程序指向不同的端点,请在你的 [Qwen 配置](https://help.aliyun.com/zh/model-studio/qwen-code) 中设置相应的配置。
