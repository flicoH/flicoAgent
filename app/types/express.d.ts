import 'express';
import type { AgentRunAccess } from '../ai/contracts';

declare module 'express-serve-static-core' {
  interface Request {
    projKey?: string;
    agentRunAccess?: AgentRunAccess;
  }
}
