const assert = require('assert');
const { loadMcpConfig } = require('../../dist/ai/mcp/internal/load-mcp-config');
const { McpClient } = require('../../dist/ai/mcp/mcp.client');
const { McpLoader } = require('../../dist/ai/mcp/mcp.loader');
const { McpRegistryService } = require('../../dist/ai/mcp/mcp-registry.service');
const { ToolRegistryService } = require('../../dist/ai/tool/tool-registry.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');

describe('MCP Client · Loader · Registry · 统一 ToolRegistry', () => {

  describe('1 & 2: loadMcpConfig 配置解析与校验', () => {
    it('缺省 ai.mcp 时返回 enabled=false 与空 servers', () => {
      const mockConfig = {
        get: (key) => undefined,
      };
      const result = loadMcpConfig(mockConfig);
      assert.strictEqual(result.enabled, false);
      assert.deepStrictEqual(result.servers, []);
    });

    it('丢弃同时缺少 command 与 url 的 server 条目', () => {
      const mockConfig = {
        get: (key) => ({
          enabled: true,
          servers: [
            { name: 'invalid-server' },
            { name: 'valid-stdio', command: 'node' },
          ],
        }),
      };
      const result = loadMcpConfig(mockConfig);
      assert.strictEqual(result.enabled, true);
      assert.strictEqual(result.servers.length, 1);
      assert.strictEqual(result.servers[0].name, 'valid-stdio');
    });

    it('command 与 url 两个都有时报错不要猜', () => {
      const mockConfig = {
        get: (key) => ({
          enabled: true,
          servers: [
            { name: 'conflict-server', command: 'node', url: 'http://localhost:3000' },
          ],
        }),
      };
      assert.throws(
        () => loadMcpConfig(mockConfig),
        /cannot configure both "command" and "url"/,
      );
    });

    it('保留 name + (command 或 url) 的条目，不强制过滤掉 url', () => {
      const mockConfig = {
        get: (key) => ({
          enabled: true,
          servers: [
            { name: 'stdio-srv', command: 'node', args: ['server.js'] },
            { name: 'http-srv', url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: 'Bearer token' } },
          ],
        }),
      };
      const result = loadMcpConfig(mockConfig);
      assert.strictEqual(result.enabled, true);
      assert.strictEqual(result.servers.length, 2);
      assert.strictEqual(result.servers[0].name, 'stdio-srv');
      assert.strictEqual(result.servers[0].command, 'node');
      assert.strictEqual(result.servers[1].name, 'http-srv');
      assert.strictEqual(result.servers[1].url, 'http://127.0.0.1:8080/mcp');
    });
  });

  describe('3: McpClient stdio 传输', () => {
    it('stdio 握手、换行分隔 JSON-RPC、listTools 与 callTool', async () => {
      // 启动一个简易 Node 子进程作为 MCP Server，响应换行分隔的 JSON-RPC
      const mockServerScript = `
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          if (!line.trim()) return;
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: msg.params.protocolVersion, capabilities: {} }
            }) + '\\n');
          } else if (msg.method === 'notifications/initialized') {
            // notification, no response
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }
                ]
              }
            }) + '\\n');
          } else if (msg.method === 'tools/call') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'Hello ' + msg.params.arguments.name }] }
            }) + '\\n');
          }
        });
      `;

      const client = new McpClient({
        name: 'test-stdio',
        command: process.execPath,
        args: ['-e', mockServerScript],
        timeoutMs: 5000,
      });

      await client.connect();

      const tools = await client.listTools();
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].name, 'test_tool');

      const callRes = await client.callTool('test_tool', { name: 'World' });
      assert.deepStrictEqual(callRes, {
        content: [{ type: 'text', text: 'Hello World' }],
      });

      await client.close();
    });
  });

  describe('3: McpClient HTTP 传输 (Streamable HTTP / SSE / Session)', () => {
    let originalFetch;
    let receivedSessionId;
    let initializedProtocolVersion;
    let receivedHeaders;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('HTTP 握手回传 mcp-session-id、protocolVersion=2025-03-26、解析 SSE 响应与关闭', async () => {
      global.fetch = async (url, options) => {
        const msg = JSON.parse(options.body);
        receivedHeaders = options.headers;
        receivedSessionId = options.headers['mcp-session-id'];

        if (msg.method === 'initialize') {
          initializedProtocolVersion = msg.params.protocolVersion;
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'Content-Type': 'application/json',
              'mcp-session-id': 'session-xyz-123',
            }),
            text: async () => JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2025-03-26' },
            }),
          };
        } else if (msg.method === 'notifications/initialized') {
          return {
            ok: true,
            status: 204,
            headers: new Headers(),
            text: async () => '',
          };
        } else if (msg.method === 'tools/list') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'Content-Type': 'text/event-stream',
            }),
            text: async () => `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [{ name: 'remote_calc', description: 'Remote calc', inputSchema: {} }],
              },
            })}\n\n`,
          };
        } else if (msg.method === 'tools/call') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'Content-Type': 'application/json',
            }),
            text: async () => JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { sum: msg.params.arguments.a + msg.params.arguments.b },
            }),
          };
        }
        throw new Error('Unexpected method: ' + msg.method);
      };

      const client = new McpClient({
        name: 'test-http',
        url: 'http://127.0.0.1:8080/mcp',
        headers: {
          'X-Custom-Auth': 'secret-token',
        },
        timeoutMs: 5000,
      });

      await client.connect();
      assert.strictEqual(initializedProtocolVersion, '2025-03-26');

      const tools = await client.listTools();
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].name, 'remote_calc');
      // 验证后续请求回传 mcp-session-id
      assert.strictEqual(receivedSessionId, 'session-xyz-123');
      assert.strictEqual(receivedHeaders['X-Custom-Auth'], 'secret-token');
      assert.strictEqual(receivedHeaders['Accept'], 'application/json, text/event-stream');

      const callRes = await client.callTool('remote_calc', { a: 10, b: 32 });
      assert.deepStrictEqual(callRes, { sum: 42 });

      await client.close();
    });
  });

  describe('4, 5, 6, 7, 8, 9: Loader · Registry · ToolRegistry · Executor', () => {
    it('适配 MCP 工具为 ToolDefinition (source: "mcp") 并由 ToolRegistry 统一调度', async () => {
      const mockServerScript = `
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          if (!line.trim()) return;
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2025-03-26' }
            }) + '\\n');
          } else if (msg.method === 'notifications/initialized') {
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  { name: 'mcp_echo', description: 'MCP echo tool', inputSchema: { type: 'object' } }
                ]
              }
            }) + '\\n');
          } else if (msg.method === 'tools/call') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { echo: msg.params.arguments.text }
            }) + '\\n');
          }
        });
      `;

      const mockConfigService = {
        get: (key) => ({
          enabled: true,
          servers: [
            {
              name: 'stdio-echo',
              command: process.execPath,
              args: ['-e', mockServerScript],
              timeoutMs: 5000,
            },
          ],
        }),
      };

      const loader = new McpLoader(mockConfigService);
      const registry = new McpRegistryService(loader);

      // 模拟 ToolRegistryService
      const mockModuleRef = {
        get: () => undefined,
      };
      const toolRegistry = new ToolRegistryService(mockModuleRef);

      // 加载并注册
      const loadedTools = await loader.load();
      assert.strictEqual(loadedTools.length, 1);
      assert.strictEqual(loadedTools[0].source, 'mcp');

      registry.registerAll(toolRegistry, loadedTools);

      // 验证 ToolRegistry list 包含 source
      const allTools = toolRegistry.list();
      const mcpEcho = allTools.find((t) => t.name === 'mcp_echo');
      assert.ok(mcpEcho);
      assert.strictEqual(mcpEcho.source, 'mcp');

      // 验证 ExecutorService 执行通用 Tool (无 if(mcp) 分支，一律 tool.execute)
      const mockSkillScanner = {
        get: () => undefined,
      };
      const executor = new ExecutorService(mockSkillScanner, toolRegistry);

      const execResult = await executor.execute('mcp_echo', { text: 'antigravity' }, { runId: 'test-run' });
      assert.strictEqual(execResult.type, 'tool');
      assert.strictEqual(execResult.source, 'mcp');
      assert.deepStrictEqual(execResult.output, { echo: 'antigravity' });

      // 清理 client
      await loader.closeAll();
    });
  });

});
