import { spawn, ChildProcess } from 'node:child_process';
import { McpServerConfig, McpToolDescriptor } from './mcp.types';

/**
 * 待响应的 JSON-RPC 请求回调载体
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * MCP 客户端 (McpClient)
 *
 * 【架构职责】
 * 统一承接与外部 MCP (Model Context Protocol) Server 的通信：
 * 1. 传输分流：
 *    - stdio (有 command)：通过 spawn 拉起子进程，按行分隔的 JSON-RPC 交互；
 *    - HTTP (有 url)：直接 POST 到远端 URL，支持 Streamable HTTP / SSE，不启动子进程；
 * 2. 统一协议：
 *    - 对上暴露统一的 connect / listTools / callTool / close 接口，禁止两套业务 API；
 *    - 握手严格遵循 MCP 规范：initialize (protocolVersion='2025-03-26') → notifications/initialized；
 * 3. 错误与超时：
 *    - 子进程退出、断连、请求超时均抛出可序列化 Error，供 Executor 封装为 observation。
 */
export class McpClient {
  public readonly name: string;
  private readonly timeoutMs: number;
  private nextId = 1;
  private isConnected = false;
  private isClosed = false;

  // stdio 传输状态
  private child?: ChildProcess;
  private stdoutBuffer = '';
  private readonly pendingRequests = new Map<number | string, PendingRequest>();

  // HTTP 传输状态
  private sessionId?: string;

  constructor(private readonly config: McpServerConfig) {
    this.name = config.name;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /**
   * 获取当前 MCP Server 名称
   */
  getServerName(): string {
    return this.name;
  }

  /**
   * 获取当前 MCP Server 配置
   */
  getConfig(): McpServerConfig {
    return this.config;
  }

  /**
   * 建立与 MCP Server 的连接并完成标准协议握手
   *
   * 1. 传输层建立（stdio spawn 或 HTTP 初始化）
   * 2. 发送 initialize 请求（params.protocolVersion = '2025-03-26'）
   * 3. 接收 initialize 响应后，立即发送 notifications/initialized（无 id）
   */
  async connect(): Promise<void> {
    if (this.isClosed) {
      throw new Error(`MCP server "${this.name}" client is closed`);
    }

    if (this.config.command) {
      await this.connectStdio();
    } else if (this.config.url) {
      await this.connectHttp();
    } else {
      throw new Error(`MCP server "${this.name}" must configure either command or url`);
    }

    // MCP initialize：params.protocolVersion = '2025-03-26'
    await this.sendRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'agent',
        version: '1.0.0',
      },
    });

    // 收到 initialize 响应后发 notifications/initialized（无 id）
    await this.sendNotification('notifications/initialized', {});
    this.isConnected = true;
  }

  /**
   * 拉取该 MCP Server 提供的工具清单 (tools/list)
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.sendRequest('tools/list', {})) as {
      tools?: McpToolDescriptor[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /**
   * 调用该 MCP Server 上的指定工具 (tools/call)
   *
   * @param name 工具名称
   * @param args 工具入参
   * @returns 工具调用结果
   */
  async callTool(name: string, args?: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.sendRequest('tools/call', {
      name,
      arguments: args ?? {},
    }, signal);
  }

  /**
   * 关闭连接并清理资源
   * - stdio：kill 子进程并清理 pending 请求；
   * - HTTP：断开连接与重置 session，禁止杀掉远端已有服务。
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.isConnected = false;

    if (this.child) {
      await this.closeStdio();
    }

    if (this.config.url) {
      await this.closeHttp();
    }
  }

  // ---------------------------------------------------------------------------
  // 核心统一 JSON-RPC 通信层
  // ---------------------------------------------------------------------------

  /**
   * 发送带 id 的 JSON-RPC 请求并等待对应响应
   */
  private async sendRequest(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.isClosed) {
      throw new Error(`MCP server "${this.name}" client is closed`);
    }

    const id = this.nextId++;

    if (this.config.command) {
      return this.sendStdioRequest(id, method, params, signal);
    }
    if (this.config.url) {
      return this.sendHttpRequest(id, method, params, signal);
    }

    throw new Error(`MCP server "${this.name}" has no valid transport`);
  }

  /**
   * 发送无 id 的单向 JSON-RPC 通知
   */
  private async sendNotification(method: string, params?: unknown): Promise<void> {
    if (this.isClosed) {
      throw new Error(`MCP server "${this.name}" client is closed`);
    }

    if (this.config.command) {
      return this.sendStdioNotification(method, params);
    }
    if (this.config.url) {
      return this.sendHttpNotification(method, params);
    }
  }

  // ---------------------------------------------------------------------------
  // stdio 传输实现 (换行分隔 JSON-RPC，严禁 Content-Length 帧)
  // ---------------------------------------------------------------------------

  private async connectStdio(): Promise<void> {
    const cwd = this.config.cwd || process.cwd();

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      try {
        this.child = spawn(this.config.command!, this.config.args ?? [], {
          cwd,
          env: { ...process.env, ...this.config.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        return reject(new Error(`Failed to spawn MCP server "${this.name}": ${err.message}`));
      }

      const onEarlyError = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to start MCP server "${this.name}": ${err.message}`));
        }
      };

      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!settled) {
          settled = true;
          reject(new Error(`MCP server "${this.name}" exited early (code=${code}, signal=${signal})`));
        }
      };

      this.child.once('error', onEarlyError);
      this.child.once('exit', onEarlyExit);

      // 管道数据块不保证与消息边界对齐：保留末尾未完成的行，等下一个数据块补齐。
      this.child.stdout?.on('data', (chunk: Buffer | string) => {
        this.stdoutBuffer += chunk.toString();
        let newlineIdx = this.stdoutBuffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
          if (line) {
            this.handleJsonRpcLine(line);
          }
          newlineIdx = this.stdoutBuffer.indexOf('\n');
        }
      });

      // stderr 只打日志，不参与协议
      this.child.stderr?.on('data', (chunk: Buffer | string) => {
        console.error(`[MCP:${this.name}:stderr] ${chunk.toString().trim()}`);
      });

      // 长期错误与退出监听
      this.child.on('error', (err: Error) => {
        this.handleProcessTermination(new Error(`MCP server "${this.name}" process error: ${err.message}`));
      });

      this.child.on('exit', (code, signal) => {
        this.handleProcessTermination(new Error(`MCP server "${this.name}" process exited (code=${code}, signal=${signal})`));
      });

      // 进入下一事件循环微任务，确保 spawn 无同步抛错后完成传输层准备
      setImmediate(() => {
        if (!settled) {
          settled = true;
          this.child?.removeListener('error', onEarlyError);
          this.child?.removeListener('exit', onEarlyExit);
          resolve();
        }
      });
    });
  }

  /** 通过 JSON-RPC id 找到等待中的请求；通知、未知 id 和超时后的迟到响应不参与匹配。 */
  private handleJsonRpcLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg && typeof msg === 'object' && msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          if (msg.error) {
            const errText = msg.error.message || JSON.stringify(msg.error);
            pending.reject(new Error(`MCP server "${this.name}" error: ${errText}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch (e) {
      console.warn(`[MCP:${this.name}] unparseable stdout line: ${line}`);
    }
  }

  /** 子进程退出后统一拒绝所有尚未完成的请求，避免调用方一直等待。 */
  private handleProcessTermination(err: Error): void {
    this.isConnected = false;
    for (const [, req] of this.pendingRequests.entries()) {
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  private sendStdioRequest(id: number | string, method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`MCP server "${this.name}" process is not running or stdin is closed`);
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      // stdio 子进程由所有会话共享。断连取消这一条等待，并忽略远端迟到的响应。
      const onAbort = () => fail(signal!.reason);
      const timer = setTimeout(() => {
        fail(new Error(`MCP request "${method}" to server "${this.name}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      // 先登记回调再写入 stdin，避免响应先到而找不到等待者。
      this.pendingRequests.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: fail,
      });
      signal?.addEventListener('abort', onAbort, { once: true });

      // 换行分隔 JSON-RPC，write 末尾带 '\n'，严禁 Content-Length 帧
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      }) + '\n';

      this.child!.stdin!.write(payload, (writeErr) => {
        if (writeErr) {
          fail(new Error(`Failed to write to MCP server "${this.name}" stdin: ${writeErr.message}`));
        }
      });
    });
  }

  private sendStdioNotification(method: string, params?: unknown): Promise<void> {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`MCP server "${this.name}" process is not running or stdin is closed`);
    }

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: params ?? {},
      }) + '\n';

      this.child!.stdin!.write(payload, (writeErr) => {
        if (writeErr) {
          reject(new Error(`Failed to write notification to MCP server "${this.name}": ${writeErr.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  private async closeStdio(): Promise<void> {
    this.handleProcessTermination(new Error(`MCP server "${this.name}" client closed`));
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP 传输实现 (POST JSON-RPC / Streamable HTTP SSE，严禁 spawn)
  // ---------------------------------------------------------------------------

  private async connectHttp(): Promise<void> {
    // 纯远端 HTTP 模式，禁止 spawn 进程，仅做前置状态准备
    this.sessionId = undefined;
  }

  private async sendHttpRequest(id: number | string, method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`MCP request "${method}" to server "${this.name}" timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    try {
      const res = await fetch(this.config.url!, {
        method: 'POST',
        headers,
        body,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });

      // initialize 响应若有 mcp-session-id，后续请求回传该头
      const newSessionId = res.headers.get('mcp-session-id');
      if (newSessionId) {
        this.sessionId = newSessionId;
      }

      if (!res.ok) {
        let errBody = '';
        try {
          errBody = await res.text();
        } catch {}
        throw new Error(`MCP server "${this.name}" HTTP ${res.status}: ${errBody || res.statusText}`);
      }

      const text = await res.text();
      const responseMsg = this.parseHttpResponse(text, id);

      if (responseMsg.error) {
        const errText = responseMsg.error.message || JSON.stringify(responseMsg.error);
        throw new Error(`MCP server "${this.name}" error: ${errText}`);
      }

      return responseMsg.result;
    } catch (err: any) {
      signal?.throwIfAborted();
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new Error(`MCP request "${method}" to server "${this.name}" timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`MCP request "${method}" to server "${this.name}" failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 通知没有 JSON-RPC 响应；网络失败只记录日志，HTTP 状态码也不会在此检查。 */
  private async sendHttpNotification(method: string, params?: unknown): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: params ?? {},
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const res = await fetch(this.config.url!, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      const newSessionId = res.headers.get('mcp-session-id');
      if (newSessionId) {
        this.sessionId = newSessionId;
      }
    } catch (err: any) {
      console.error(`[MCP:${this.name}] notification "${method}" failed:`, err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解析已完整读取的 HTTP 响应体：支持标准 JSON 与 SSE 的单行 data JSON。
   * JSON 直接返回；SSE 优先匹配请求 id，找不到时回退到第一个可解析的对象。
   */
  private parseHttpResponse(text: string, expectedId: number | string): any {
    const trimmed = text.trim();

    // 1. 尝试直接作为标准 JSON 解析
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }

    // 2. 尝试作为 Server-Sent Events (SSE) 流文本解析
    const lines = text.split('\n');
    let fallbackMsg: any;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('data:')) {
        const dataStr = trimmedLine.slice(5).trim();
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed && typeof parsed === 'object') {
            if (parsed.id === expectedId) {
              return parsed;
            }
            fallbackMsg = fallbackMsg ?? parsed;
          }
        } catch {}
      }
    }

    if (fallbackMsg) {
      return fallbackMsg;
    }

    throw new Error(`MCP server "${this.name}" returned empty or unparseable response`);
  }

  private async closeHttp(): Promise<void> {
    // 关闭时只断开连接，不要试图杀掉远端已有服务进程
    this.sessionId = undefined;
  }
}
