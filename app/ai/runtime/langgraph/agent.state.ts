import { Annotation } from '@langchain/langgraph';
import type { StructuredTool } from '@langchain/core/tools';
import type { ExecutionResult, LlmMessage, Step } from '../../contracts';
import type { LangChainToolCall } from '../langchain/langchain-planner.service';

export interface GraphStep extends Step {
  node?: 'plan' | 'execute' | 'observe' | 'make-plan' | 'synthesize' | 'review';
  planner?: 'langchain';
  [key: string]: unknown;
}

export interface GraphPendingApproval {
  id: string;
  kind: 'skill' | 'tool';
  name: string;
  input: unknown;
  index: number;
  callId: string;
}

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<LlmMessage[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  iteration: Annotation<number>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => 0,
  }),
  maxIterations: Annotation<number>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => 5,
  }),
  tools: Annotation<StructuredTool[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  toolCalls: Annotation<LangChainToolCall[] | undefined>({
    reducer: (_x, y) => y,
    default: () => undefined,
  }),
  executionResults: Annotation<ExecutionResult[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  resumeIndex: Annotation<number>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => 0,
  }),
  approvedCallId: Annotation<string | undefined>({
    reducer: (_x, y) => y,
    default: () => undefined,
  }),
  rejectedCallId: Annotation<string | undefined>({
    reducer: (_x, y) => y,
    default: () => undefined,
  }),
  pendingApproval: Annotation<GraphPendingApproval | undefined>({
    reducer: (_x, y) => y,
    default: () => undefined,
  }),
  taskPlan: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  taskIndex: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  previousDraft: Annotation<string | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),
  reflectionRevisions: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  finalAnswer: Annotation<string | undefined>({
    reducer: (_x, y) => y,
    default: () => undefined,
  }),
  isMaxIterationError: Annotation<boolean>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => false,
  }),
  steps: Annotation<GraphStep[]>({
    reducer: (x, y) => (Array.isArray(y) ? x.concat(y) : x),
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;
