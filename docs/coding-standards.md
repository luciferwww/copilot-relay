# 编码规范

> 创建日期：2026-04-07  
> 适用范围：my-agent 项目所有 TypeScript 代码

本文档总结自现有代码库的实际风格，新代码应保持一致。

---

## 1. 文件命名

| 类型 | 命名风格 | 示例 |
|------|---------|------|
| 类/主模块 | PascalCase | `AgentRunner.ts`, `SessionManager.ts` |
| 工具/辅助函数 | kebab-case | `read-file.ts`, `run-command.ts`, `path-policy.ts` |
| 类型定义 | `types.ts` | 每个模块一个，或 `types/` 子目录 |
| 模块入口 | `index.ts` | 只做 re-export，不含实现 |
| 测试 | 与源文件同名 + `.test.ts` | `AgentRunner.test.ts`, `lock.test.ts` |

---

## 2. 目录命名

一律 **kebab-case**：

```
agent-runner/    llm-client/    prompt-builder/    session/    tools/
```

---

## 3. 命名规则

| 类别 | 风格 | 示例 |
|------|------|------|
| 类 | PascalCase，无前后缀 | `AgentRunner`, `SessionManager` |
| 接口 | PascalCase，无 `I` 前缀 | `RunParams`, `ToolResult`, `SessionEntry` |
| 函数 | camelCase | `loadStore()`, `extractText()`, `createMemoryTools()` |
| 变量 | camelCase | `sessionManager`, `currentText`, `workspaceDir` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_MAX_TOKENS`, `SESSIONS_DIR` |
| 私有成员 | `private` 关键字 + camelCase | `private llmClient`, `private transcripts` |

### 接口命名后缀惯例

| 后缀 | 用途 | 示例 |
|------|------|------|
| `Config` / `Options` | 构造参数、配置 | `AgentRunnerConfig`, `LoadContextFilesOptions` |
| `Params` / `Input` | 方法参数 | `RunParams`, `ChatParams`, `UserPromptInput` |
| `Result` / `Response` | 返回值 | `RunResult`, `ChatResponse`, `ToolResult` |
| `Entry` / `Record` | 数据条目 | `SessionEntry`, `MessageRecord` |
| `Event` | 事件 | `AgentEvent`, `StreamEvent` |
| `Definition` | 定义/描述 | `ToolDefinition`, `ChatToolDefinition` |

---

## 4. 模块结构

典型模块组织：

```
module-name/
├── ClassName.ts           # 主类（PascalCase）
├── helper-name.ts         # 辅助函数（kebab-case）
├── types.ts               # 接口和类型
├── index.ts               # re-export 公共 API
├── ClassName.test.ts      # 主类测试
└── helper-name.test.ts    # 辅助函数测试
```

- 接口统一放在 `types.ts`（或 `types/` 子目录），不为单个接口建文件
- `index.ts` 只做 re-export，不含实现逻辑
- 辅助函数文件用 kebab-case（如 `store.ts`, `lock.ts`, `transcript.ts`）

---

## 5. 导入导出

### 导入

```typescript
// 值导入
import { SessionManager } from './SessionManager.js';
import { readFile } from 'fs/promises';
import { join } from 'node:path';

// 类型导入（单独的 import type）
import type { SessionEntry, MessageRecord } from './types.js';
import type { LLMClient, ChatMessage } from '../llm-client/types.js';
```

规则：
- 相对路径始终带 `.js` 后缀
- 类型导入使用 `import type` 分开写
- Node.js 内置模块可用 `node:` 前缀或不带

### 导出

```typescript
// 类和函数：命名导出
export class AgentRunner { }
export function loadStore() { }
export const execTool: Tool = { };

// index.ts 中的 re-export
export { AgentRunner } from './AgentRunner.js';
export type { RunParams, RunResult, AgentEvent } from './types.js';
```

规则：
- 使用命名导出，不用 default export
- `export type` 用于纯类型的 re-export

---

## 6. 注释

### JSDoc — 公共 API

```typescript
/**
 * Agent 执行引擎，串联所有模块完成一次完整的对话循环。
 *
 * 两层循环结构：
 * - 外层：处理 followUp 消息
 * - 内层：LLM 调用 + tool use 循环
 */
export class AgentRunner { }
```

### 行内注释 — 逻辑说明

```typescript
// 从 session 加载历史消息，转换为 ChatMessage[]
const history = this.loadHistory(params.sessionKey);
```

### 分隔线 — 文件内分区

```typescript
// ── Section 1: agent-identity ──────────────────────────────
// ── 内部方法 ──────────────────────────────────────────
```

- 中英文均可，保持同一文件内风格统一
- 不写多余的 `@param` / `@returns`，TypeScript 类型已经表达了

---

## 7. 错误处理

```typescript
// 抛出错误：明确的错误消息
throw new Error(`Session key "${key}" not found`);

// 捕获错误：类型守卫
try {
  await operation();
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  throw error;
}

// 工具返回错误：isError 标记
return {
  content: `Error: ${message}`,
  isError: true,
};

// 文件不存在等预期错误：静默跳过
try {
  rawContent = await readFile(filePath, 'utf-8');
} catch {
  continue; // 文件不存在，跳过
}
```

---

## 8. 异步模式

```typescript
// 标准：async/await
async run(params: RunParams): Promise<RunResult> {
  const result = await this.callLLM(params);
  return result;
}

// 流式：AsyncIterable
async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
  for await (const event of stream) {
    yield event;
  }
}

// 回调：简单场景用可选回调
onEvent?: (event: AgentEvent) => void;
```

---

## 9. 测试

框架：**Vitest**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('SessionManager', () => {
  let workspaceDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'test-'));
    manager = new SessionManager(workspaceDir);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    it('creates a session with UUID and JSONL file', async () => {
      const entry = await manager.createSession('main');
      expect(entry.sessionId).toBeDefined();
    });
  });
});
```

规则：
- 临时目录用 `mkdtemp()`，`afterEach` 清理
- `describe` 按功能分组，`it` 描述具体行为
- 每个测试独立，不共享可变状态
- Mock 对象内联创建

---

## 10. 其他约定

| 约定 | 说明 |
|------|------|
| 文件编码 | UTF-8，文件读写显式指定 `'utf-8'` |
| 模块系统 | ES Modules（`"type": "module"`） |
| TypeScript | `strict: true`，ES2022 target |
| 日志 | 不用第三方日志库，用事件发射（`this.emit()`）或 `warn` 回调 |
| 平台 | `process.platform` 检测，避免硬编码路径分隔符 |
| 内存状态 | 用 `Map` 管理（如 `Map<string, TranscriptState>`） |
