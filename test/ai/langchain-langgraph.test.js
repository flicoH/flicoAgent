const assert = require('assert');
const { resolveMaxIterations } = require('../../dist/ai/lc-lg-runtime/internal/load-runtime-config');
const { SkillToolAdapter } = require('../../dist/ai/lc-lg-runtime/langchain/skill-tool.adapter');
const { LangChainPlannerService, toLangChainMessages, resolveModelEndpoint } = require('../../dist/ai/lc-lg-runtime/langchain/langchain-planner.service');
const { createAgentGraph, defaultAgentGraph } = require('../../dist/ai/lc-lg-runtime/langgraph/agent.graph');
const { LangGraphOrchestratorService } = require('../../dist/ai/lc-lg-runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/runtime/executor.service');

describe('T12: lc-lg-runtime · LangChain Planner · LangGraph 循环', () => {
  describe('1. load-runtime-config: resolveMaxIterations', () => {
    it('正确读取 ai.runtime.maxIterations 正数值', () => {
      const config = {
        get(key) {
          if (key === 'ai.runtime.maxIterations') return 8;
          return undefined;
        },
      };
      assert.strictEqual(resolveMaxIterations(config), 8);
    });

    it('支持字符串数字解析为正整数', () => {
      const config = {
        get(key) {
          if (key === 'ai.runtime.maxIterations') return ' 12 ';
          return undefined;
        },
      };
      assert.strictEqual(resolveMaxIterations(config), 12);
    });

    it('缺省 / 非数字 / <=0 时严格回退到默认 5（禁止不设限）', () => {
      const emptyConfig = { get: () => undefined };
      assert.strictEqual(resolveMaxIterations(emptyConfig), 5);
      assert.strictEqual(resolveMaxIterations(null), 5);

      const invalidConfigs = [
        { get: () => 'abc' },
        { get: () => -3 },
        { get: () => 0 },
        { get: () => null },
        { get: () => ({}) },
      ];
      for (const cfg of invalidConfigs) {
        assert.strictEqual(resolveMaxIterations(cfg), 5);
      }
    });
  });

  describe('2. skill-tool.adapter: Skill/Tool → StructuredTool & 转调 Scanner/Registry', () => {
    it('将 SkillDefinition 转换为 StructuredTool 并转调 SkillScannerService', async () => {
      let executedWith = null;
      const mockSkills = {
        get(name) {
          if (name === 'test-skill') {
            return {
              name: 'test-skill',
              description: 'Skill description',
              inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
              async execute(input, ctx) {
                executedWith = { input, ctx };
                return { success: true, answer: 'skill done' };
              },
            };
          }
          return undefined;
        },
      };
      const mockTools = { get: () => undefined };
      const adapter = new SkillToolAdapter(mockSkills, mockTools);

      const tool = adapter.adaptSkill(mockSkills.get('test-skill'), { runId: 'run-1' });
      assert.strictEqual(tool.name, 'test-skill');
      assert.strictEqual(tool.description, 'Skill description');
      assert.deepStrictEqual(tool.schema, { type: 'object', properties: { q: { type: 'string' } } });

      const resultStr = await tool.invoke({ q: 'hello' });
      assert.deepStrictEqual(executedWith, { input: { q: 'hello' }, ctx: { runId: 'run-1' } });
      assert.strictEqual(resultStr, JSON.stringify({ success: true, answer: 'skill done' }));
    });

    it('将 ToolDefinition（含 MCP）转换为 StructuredTool 并转调 ToolRegistryService', async () => {
      let executedInput = null;
      const mockSkills = { get: () => undefined };
      const mockTools = {
        get(name) {
          if (name === 'mcp_tool') {
            return {
              name: 'mcp_tool',
              description: 'MCP tool description',
              source: 'mcp',
              inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
              async execute(input) {
                executedInput = input;
                return 'mcp output';
              },
            };
          }
          return undefined;
        },
      };
      const adapter = new SkillToolAdapter(mockSkills, mockTools);

      const tool = adapter.adaptTool(mockTools.get('mcp_tool'));
      assert.strictEqual(tool.name, 'mcp_tool');
      assert.strictEqual(tool.description, 'MCP tool description');

      const resultStr = await tool.invoke({ cmd: 'ping' });
      assert.deepStrictEqual(executedInput, { cmd: 'ping' });
      assert.strictEqual(resultStr, 'mcp output');
    });

    it('adaptForAgent 严格按白名单批量装配', () => {
      const mockSkills = {
        get(name) {
          if (name === 's1') return { name: 's1', description: 's1 desc', inputSchema: {} };
          return undefined;
        },
      };
      const mockTools = {
        get(name) {
          if (name === 't1') return { name: 't1', description: 't1 desc', inputSchema: {} };
          return undefined;
        },
      };
      const adapter = new SkillToolAdapter(mockSkills, mockTools);
      const adapted = adapter.adaptForAgent(['s1', 's_unregistered'], ['t1', 't_unregistered']);

      assert.strictEqual(adapted.length, 2);
      assert.strictEqual(adapted[0].name, 's1');
      assert.strictEqual(adapted[1].name, 't1');
    });
  });

  describe('3. langchain-planner.service: bindTools & plan()', () => {
    it('toLangChainMessages 正确转换各种角色和 tool_calls', () => {
      const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user question' },
        {
          role: 'assistant',
          content: 'calling tool',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'query', arguments: '{"id":"1"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result 1' },
      ];

      const lcMessages = toLangChainMessages(messages);
      assert.strictEqual(lcMessages.length, 4);
      assert.strictEqual(lcMessages[0]._getType(), 'system');
      assert.strictEqual(lcMessages[1]._getType(), 'human');
      assert.strictEqual(lcMessages[2]._getType(), 'ai');
      assert.strictEqual(lcMessages[2].tool_calls.length, 1);
      assert.strictEqual(lcMessages[2].tool_calls[0].name, 'query');
      assert.deepStrictEqual(lcMessages[2].tool_calls[0].args, { id: '1' });
      assert.strictEqual(lcMessages[3]._getType(), 'tool');
      assert.strictEqual(lcMessages[3].tool_call_id, 'call_1');
    });

    it('plan 步结果包含 planner="langchain"', async () => {
      const mockConfig = {
        get(key) {
          if (key === 'ai.llm') {
            return {
              default: 'test-model',
              models: {
                'test-model': { provider: 'openai-compatible', baseURL: 'http://localhost', apiKey: 'mock' },
              },
            };
          }
          return undefined;
        },
      };

      const planner = new LangChainPlannerService(mockConfig);
      // Mock invoke on bindTools
      planner.bindTools = (tools, model) => ({
        async invoke(msgs) {
          return {
            content: 'This is final answer',
            tool_calls: [],
          };
        },
      });

      const planResult = await planner.plan([{ role: 'user', content: 'hi' }], []);
      assert.strictEqual(planResult.planner, 'langchain');
      assert.strictEqual(planResult.finalAnswer, 'This is final answer');
      assert.strictEqual(planResult.toolCalls, undefined);
    });

    it('当模型产出 tool_calls 时返回 toolCalls 数组并保留结构', async () => {
      const mockConfig = { get: () => undefined };
      const planner = new LangChainPlannerService(mockConfig);

      planner.bindTools = () => ({
        async invoke() {
          return {
            content: '',
            tool_calls: [{
              id: 'call_99',
              name: 'fetch_user',
              args: { userId: 42 },
            }],
          };
        },
      });

      const planResult = await planner.plan([], []);
      assert.strictEqual(planResult.planner, 'langchain');
      assert.ok(Array.isArray(planResult.toolCalls));
      assert.strictEqual(planResult.toolCalls.length, 1);
      assert.strictEqual(planResult.toolCalls[0].name, 'fetch_user');
      assert.deepStrictEqual(planResult.toolCalls[0].args, { userId: 42 });
      assert.strictEqual(planResult.finalAnswer, undefined);
    });

    it('resolveModelEndpoint 与 getModel 准确解析主流兼容厂商 (kimi/qwen/deepseek) 的 baseURL 与 model', () => {
      // 1. 测试 kimi 厂商映射
      const kimiResolved = resolveModelEndpoint('kimi', { apiKey: 'sk-kimi-key' });
      assert.strictEqual(kimiResolved.baseURL, 'https://api.moonshot.cn/v1');
      assert.strictEqual(kimiResolved.model, 'kimi-k2.6');
      assert.strictEqual(kimiResolved.apiKey, 'sk-kimi-key');

      // 2. 测试 qwen 厂商映射
      const qwenResolved = resolveModelEndpoint('qwen', { apiKey: 'sk-qwen-key' });
      assert.strictEqual(qwenResolved.baseURL, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
      assert.strictEqual(qwenResolved.model, 'qwen-plus');

      // 3. 测试 deepseek 厂商映射
      const dsResolved = resolveModelEndpoint('deepseek', { apiKey: 'sk-ds-key' });
      assert.strictEqual(dsResolved.baseURL, 'https://api.deepseek.com/v1');
      assert.strictEqual(dsResolved.model, 'deepseek-chat');

      // 4. 测试自定义 Provider (use: KimiProvider)
      class KimiProvider {}
      const customKimiResolved = resolveModelEndpoint(undefined, { use: KimiProvider, apiKey: 'sk-custom' });
      assert.strictEqual(customKimiResolved.baseURL, 'https://api.moonshot.cn/v1');
      assert.strictEqual(customKimiResolved.model, 'kimi-k2.6');

      // 5. 测试显式配置优先
      const explicitResolved = resolveModelEndpoint('kimi', {
        baseURL: 'https://my-custom-proxy.internal/v1',
        model: 'custom-kimi-model',
        apiKey: 'sk-explicit',
      });
      assert.strictEqual(explicitResolved.baseURL, 'https://my-custom-proxy.internal/v1');
      assert.strictEqual(explicitResolved.model, 'custom-kimi-model');

      // 6. 测试 planner.getModel 正常创建 ChatOpenAI 实例并装配客户端配置
      const mockConfig = {
        get(key) {
          if (key === 'ai.llm') {
            return {
              default: 'kimi',
              models: {
                kimi: { apiKey: 'sk-real-test' },
              },
            };
          }
          return undefined;
        },
      };
      const planner = new LangChainPlannerService(mockConfig);
      const model = planner.getModel();
      assert.strictEqual(model.clientConfig.baseURL, 'https://api.moonshot.cn/v1');
      assert.strictEqual(model.clientConfig.apiKey, 'sk-real-test');
      assert.strictEqual(model.model, 'kimi-k2.6');
    });
  });

  describe('4. LangGraph 状态图循环 & 计数刹车 & 节点观测', () => {
    it('状态图包含 plan、execute、observe 节点与条件边', () => {
      const drawable = defaultAgentGraph.getGraph();
      const nodeKeys = Object.keys(drawable.nodes);
      assert.ok(nodeKeys.includes('plan'));
      assert.ok(nodeKeys.includes('execute'));
      assert.ok(nodeKeys.includes('observe'));
      assert.ok(nodeKeys.includes('__start__'));
      assert.ok(nodeKeys.includes('__end__'));

      const edges = drawable.edges;
      assert.ok(edges.some(e => e.source === '__start__' && e.target === 'plan'));
      assert.ok(edges.some(e => e.source === 'execute' && e.target === 'observe'));
      assert.ok(edges.some(e => e.source === 'observe' && e.target === 'plan'));
      assert.ok(edges.some(e => e.source === 'plan' && e.target === 'execute' && e.conditional));
      assert.ok(edges.some(e => e.source === 'plan' && e.target === '__end__' && e.conditional));
    });

    it('循环通过 state.iteration 进行精准计数刹车，不依赖底层 recursionLimit', async () => {
      let planCount = 0;
      const recordedSteps = [];
      const mockPlanner = {
        async plan() {
          planCount++;
          // 模拟死循环模型，一直产生 tool_calls
          return {
            planner: 'langchain',
            toolCalls: [{ id: `call_${planCount}`, name: 'infinite_tool', args: {} }],
          };
        },
      };

      const mockExecutor = {
        async execute(name, args, ctx) {
          return { type: 'tool', name, output: 'done' };
        },
      };

      const graph = createAgentGraph({
        planner: mockPlanner,
        executor: mockExecutor,
        runId: 'brake-run',
        agentName: 'brake-agent',
        recordStep: (step) => {
          recordedSteps.push(step);
        },
      });

      const maxIterations = 3;
      const result = await graph.invoke({
        messages: [{ role: 'user', content: 'test brake' }],
        tools: [],
        iteration: 0,
        maxIterations,
        steps: [],
      });

      // 迭代次数刚好刹在 maxIterations + 1（触发熔断节点）
      assert.strictEqual(result.iteration, maxIterations + 1);
      assert.strictEqual(result.isMaxIterationError, true);
      assert.strictEqual(result.finalAnswer, `Agent reached the maximum of ${maxIterations} iterations`);

      // 验证每个节点写入的 node 字段
      const nodeTags = recordedSteps.map(s => s.node);
      assert.ok(nodeTags.includes('plan'));
      assert.ok(nodeTags.includes('execute'));
      assert.ok(nodeTags.includes('observe'));

      // 验证 plan 步写有 planner='langchain'
      const planSteps = recordedSteps.filter(s => s.type === 'plan');
      assert.ok(planSteps.length > 0);
      assert.ok(planSteps.every(s => s.planner === 'langchain'));
    });
  });

  describe('5. LangGraphOrchestratorService 整合与契约保持', () => {
    it('run 与 runStream 具备同构事件及输出三字段 (runId, output, steps)', async () => {
      const mockAgents = {
        get(name) {
          return {
            name: 'test-agent',
            model: 'qwen',
            prompt: 'system prompt',
            skills: ['proj-query'],
            tools: [],
          };
        },
      };

      const mockSkills = {
        get(name) {
          if (name === 'proj-query') {
            return {
              name: 'proj-query',
              description: 'query project',
              inputSchema: {},
              async execute(input) {
                return { id: 1, name: 'Project A' };
              },
            };
          }
          return undefined;
        },
      };

      const mockTools = { get: () => undefined };

      let plannerTurns = 0;
      const mockPlanner = {
        async plan(messages, tools, options) {
          plannerTurns++;
          if (plannerTurns === 1) {
            return {
              planner: 'langchain',
              toolCalls: [{ id: 'call_1', name: 'proj-query', args: { id: 1 } }],
              response: { role: 'assistant', content: 'calling proj-query' },
            };
          }
          return {
            planner: 'langchain',
            finalAnswer: 'Project A is active',
            response: { role: 'assistant', content: 'Project A is active' },
          };
        },
      };

      const mockExecutor = new ExecutorService(mockSkills, mockTools);

      const mockTraceStore = {
        runs: new Map(),
      };
      const mockTrace = {
        async createRun(agent, input, threadId) {
          const run = { runId: 'run-uuid-1', agent, input, threadId, steps: [], createdAt: '', updatedAt: '' };
          mockTraceStore.runs.set(run.runId, run);
          return run;
        },
        async addStep(runId, step) {
          const run = mockTraceStore.runs.get(runId);
          if (run) run.steps.push(step);
        },
      };

      const mockThreadService = {
        isThreadEnabled: () => true,
        ensureThread: (id) => id || 'test-thread-id',
        truncate: (msgs) => msgs,
        buildContextMessages: () => [],
        appendTurn: (base, q, a, tid) => ({
          threadId: tid,
          messages: [...(base.messages || []), { role: 'user', content: q }, { role: 'assistant', content: a }],
          updatedAt: Date.now(),
        }),
      };

      const savedCheckpoints = [];
      const mockCheckpointService = {
        async load() { return null; },
        async save(cp) { savedCheckpoints.push(cp); },
      };

      const mockGuardrail = {
        check: (text) => ({ safe: true }),
      };

      const mockConfig = {
        get(key) {
          if (key === 'ai.runtime.maxIterations') return 5;
          return undefined;
        },
      };

      const orchestrator = new LangGraphOrchestratorService(
        mockAgents,
        mockSkills,
        mockTools,
        mockPlanner,
        mockExecutor,
        mockTrace,
        mockThreadService,
        mockCheckpointService,
        mockGuardrail,
        mockConfig,
      );

      const streamedEvents = [];
      const result = await orchestrator.run(
        'test-agent',
        'what is project 1?',
        (evt) => {
          streamedEvents.push(evt);
        },
        'custom-thread-123',
      );

      // 验证锁死合同三字段 + threadId
      assert.strictEqual(result.runId, 'run-uuid-1');
      assert.strictEqual(result.output, 'Project A is active');
      assert.strictEqual(result.threadId, 'custom-thread-123');
      assert.ok(Array.isArray(result.steps));
      assert.ok(result.steps.length >= 4); // plan(call), execute, observe, plan(final), final

      // 验证 steps 中的 node 与 planner 观测字段
      const planSteps = result.steps.filter(s => s.type === 'plan');
      assert.ok(planSteps.length >= 2);
      assert.ok(planSteps.every(s => s.planner === 'langchain' && s.node === 'plan'));

      const execStep = result.steps.find(s => s.type === 'skill');
      assert.ok(execStep);
      assert.strictEqual(execStep.node, 'execute');

      const observeStep = result.steps.find(s => s.type === 'observe');
      assert.ok(observeStep);
      assert.strictEqual(observeStep.node, 'observe');

      // 验证 SSE 产生 step 与 delta 事件
      assert.ok(streamedEvents.some(e => e.type === 'step'));
      assert.ok(streamedEvents.some(e => e.type === 'delta'));

      // 验证 Checkpoint 成功保存
      assert.strictEqual(savedCheckpoints.length, 1);
      assert.strictEqual(savedCheckpoints[0].threadId, 'custom-thread-123');

      // 验证 getGraph 拓扑反射
      const graphTopology = orchestrator.getGraph();
      assert.ok(graphTopology.nodes);
      assert.ok(graphTopology.edges);
      assert.ok(graphTopology.nodes.some(n => n.id === 'plan'));
      assert.ok(graphTopology.nodes.some(n => n.id === 'execute'));
      assert.ok(graphTopology.nodes.some(n => n.id === 'observe'));
    });

    it('不安全输入在最前端被 Guardrail 拦截并返回规定合同', async () => {
      const mockAgents = { get: () => ({ name: 'a', skills: [], tools: [] }) };
      const mockGuardrail = {
        check: () => ({ safe: false, reason: '包含违禁指令' }),
      };
      const mockTrace = {
        createRun: async (a, i, tid) => ({ runId: 'guard-run-1', agent: a, input: i, threadId: tid, steps: [] }),
        addStep: async () => {},
      };
      const mockThreadService = {
        isThreadEnabled: () => false,
        ensureThread: () => 't-id',
      };

      const orchestrator = new LangGraphOrchestratorService(
        mockAgents,
        {},
        {},
        {},
        {},
        mockTrace,
        mockThreadService,
        {},
        mockGuardrail,
        { get: () => 5 },
      );

      const res = await orchestrator.run('a', 'rm -rf /');
      assert.strictEqual(res.output, '包含违禁指令');
      assert.strictEqual(res.steps.length, 1);
      assert.strictEqual(res.steps[0].type, 'guardrail');
    });
  });

  describe('6. AiController 与 LangGraphOrchestratorService 适配 & GET agent/graph', () => {
    it('AiController 正确注入 LangGraphOrchestratorService 并支持 GET agent/graph', async () => {
      const { AiController } = require('../../dist/ai/ai.controller');

      let runCalledWith = null;
      const mockOrchestrator = {
        async run(agent, input, emit, threadId) {
          runCalledWith = { agent, input, threadId };
          return {
            runId: 'c-run-1',
            output: 'answer',
            steps: [{ type: 'plan', node: 'plan', iteration: 1 }],
            threadId: threadId || 'thread-1',
          };
        },
        getGraph() {
          return {
            nodes: [{ id: 'plan', name: 'plan' }],
            edges: [{ source: 'plan', target: 'execute', conditional: true }],
          };
        },
      };

      const controller = new AiController(
        {}, // llm
        {}, // skills
        {}, // tools
        {}, // agents
        mockOrchestrator,
        {}, // trace
        {}, // retriever
        {}, // configService
      );

      // 验证 runAgent 成功返回固定格式
      const runRes = await controller.runAgent({
        agent: 'demo-agent',
        input: 'hello',
        threadId: 't-123',
      });

      assert.strictEqual(runRes.success, true);
      assert.strictEqual(runRes.data.runId, 'c-run-1');
      assert.strictEqual(runRes.data.output, 'answer');
      assert.strictEqual(runRes.data.threadId, 't-123');
      assert.deepStrictEqual(runCalledWith, { agent: 'demo-agent', input: 'hello', threadId: 't-123' });

      // 验证 GET agent/graph 返回 { nodes, edges }
      const graphRes = controller.getAgentGraph();
      assert.ok(graphRes.nodes);
      assert.ok(graphRes.edges);
      assert.strictEqual(graphRes.nodes[0].id, 'plan');
      assert.strictEqual(graphRes.edges[0].source, 'plan');
    });
  });
});
