/**
 * ACP (Agent Communication Protocol) 类型定义。
 *
 * 定义了 Qwen ACP 客户端与 qwen --acp 服务器之间的 JSON-RPC 2.0 协议类型。
 * 协议基于 NDJSON（每行一个 JSON 对象）传输。
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求（客户端 → 服务器） */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** 请求 ID，用于匹配响应 */
  id: number;
  /** 方法名 */
  method: string;
  /** 方法参数 */
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 成功响应（服务器 → 客户端） */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  /** 匹配的请求 ID */
  id: number;
  /** 响应结果 */
  result?: Record<string, unknown>;
  error?: never;
}

/** JSON-RPC 2.0 错误响应（服务器 → 客户端） */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  /** 匹配的请求 ID */
  id: number;
  result?: never;
  /** 错误信息 */
  error: {
    /** 错误码 */
    code: number;
    /** 错误消息 */
    message: string;
    /** 额外数据 */
    data?: unknown;
  };
}

/** JSON-RPC 2.0 通知（无 ID，无需响应） */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  /** 方法名 */
  method: string;
  /** 通知参数 */
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 服务器请求（服务器 → 客户端，需要响应） */
export interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  /** 请求 ID，客户端需要响应 */
  id: number;
  /** 方法名 */
  method: string;
  /** 请求参数 */
  params?: Record<string, unknown>;
}

/** 任意 JSON-RPC 消息（联合体类型） */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification
  | JsonRpcServerRequest;

// ============================================================================
// Initialize 握手
// ============================================================================

/** initialize 请求参数 */
export interface InitializeParams {
  /** 协议版本 */
  protocolVersion: number;
  /** 客户端信息 */
  clientInfo?: {
    /** 客户端名称 */
    name?: string;
    /** 客户端版本 */
    version?: string;
    /** 客户端显示标题 */
    title?: string;
  };
  /** 客户端能力声明 */
  capabilities?: Record<string, unknown>;
}

/** initialize 响应结果 */
export interface InitializeResult {
  /** 协议版本 */
  protocolVersion: number;
  /** 服务器信息 */
  serverInfo?: {
    /** 服务器名称 */
    name?: string;
    /** 服务器版本 */
    version?: string;
  };
  /** 服务器能力声明 */
  capabilities?: Record<string, unknown>;
}

// ============================================================================
// Session 相关类型
// ============================================================================

/** session/start 请求参数 */
export interface SessionStartParams {
  /** 提示词/指令 */
  prompt: string;
  /** 沙箱模式 */
  sandbox?: boolean | "read-only" | "full";
  /** 审批策略 */
  approvalPolicy?: "never" | "on-failure" | "always";
  /** 模型名称 */
  model?: string;
  /** 推理努力程度 */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** 会话名称 */
  sessionName?: string;
}

/** session/update 通知参数 */
export interface SessionUpdate {
  /** 增量消息列表 */
  messages: Array<{
    /** 消息类型（user/assistant/tool/system） */
    type: string;
    /** 消息内容 */
    content: string;
  }>;
  /** 推理摘要（可选） */
  reasoningSummary?: Array<{
    /** 摘要类型 */
    type: string;
    /** 摘要文本 */
    text: string;
  }>;
}

/** session/completed 通知参数 */
export interface SessionCompleted {
  /** 会话 ID */
  sessionId: string;
  /** 最终状态 */
  status: "completed" | "failed" | "cancelled";
}

// ============================================================================
// Terminal 相关类型
// ============================================================================

/** terminal/create 请求参数 */
export interface TerminalCreateParams {
  /** 命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 最大输出字节数 */
  maxOutputBytes?: number;
  /** 环境变量 */
  env?: Record<string, string>;
}

/** terminal/create 响应结果 */
export interface TerminalCreateResult {
  /** 终端会话 ID */
  terminalId: string;
}

/** terminal/output 请求参数 */
export interface TerminalOutputParams {
  /** 终端会话 ID */
  terminalId: string;
}

/** terminal/output 响应结果 */
export interface TerminalOutput {
  /** 终端输出内容 */
  output: string;
  /** 是否被截断 */
  truncated: boolean;
  /** 退出状态（仅当进程已结束时存在） */
  exitStatus?: TerminalExitStatus;
}

/** 终端退出状态 */
export type TerminalExitStatus =
  | { type: "exit"; code: number }
  | { type: "signal"; signal: number }
  | { type: "running" };

/** terminal/wait_for_exit 请求参数 */
export interface TerminalWaitForExitParams {
  /** 终端会话 ID */
  terminalId: string;
  /** 超时毫秒数 */
  timeoutMs?: number;
}

/** terminal/kill 请求参数 */
export interface TerminalKillParams {
  /** 终端会话 ID */
  terminalId: string;
}

/** terminal/release 请求参数 */
export interface TerminalReleaseParams {
  /** 终端会话 ID */
  terminalId: string;
}

// ============================================================================
// File System 相关类型
// ============================================================================

/** fs/read_text_file 请求参数 */
export interface FsReadTextFileParams {
  /** 文件路径 */
  path: string;
}

/** fs/read_text_file 响应结果 */
export interface FsReadTextFileResult {
  /** 文件内容 */
  content: string;
}

/** fs/write_text_file 请求参数 */
export interface FsWriteTextFileParams {
  /** 文件路径 */
  path: string;
  /** 文件内容 */
  content: string;
}

/** fs/write_text_file 响应结果 */
export interface FsWriteTextFileResult {
  /** 是否写入成功 */
  success: boolean;
}

// ============================================================================
// Permission 相关类型
// ============================================================================

/** session/request_permission 请求参数 */
export interface PermissionRequestParams {
  /** 请求的操作 */
  action: string;
  /** 详细信息 */
  details?: Record<string, unknown>;
  /** 是否需要用户确认 */
  requiresUserConfirmation?: boolean;
}

/** 权限响应 */
export type PermissionResponse = "proceed_once" | "proceed_always" | "deny";

/** session/request_permission 响应结果 */
export interface PermissionResponseResult {
  /** 权限决策 */
  decision: PermissionResponse;
}

// ============================================================================
// Review 相关类型
// ============================================================================

/** review/start 请求参数 */
export interface ReviewStartParams {
  /** 审查目标（文件/目录/git diff） */
  target: string;
  /** 审查类型 */
  reviewType?: "diff" | "file" | "directory" | "branch";
  /** 附加上下文 */
  context?: Record<string, unknown>;
}

/** review/start 响应结果 */
export interface ReviewStartResult {
  /** 审查会话 ID */
  sessionId: string;
}

// ============================================================================
// 错误码常量
// ============================================================================

/** 标准 JSON-RPC 2.0 错误码 */
export const enum JsonRpcErrorCode {
  /** 无效的 JSON */
  ParseError = -32700,
  /** 无效的请求对象 */
  InvalidRequest = -32600,
  /** 方法不存在 */
  MethodNotFound = -32601,
  /** 无效的参数 */
  InvalidParams = -32602,
  /** 内部错误 */
  InternalError = -32603,
}

/** Broker 繁忙错误码（自定义） */
export const BROKER_BUSY_RPC_CODE = -32001;
