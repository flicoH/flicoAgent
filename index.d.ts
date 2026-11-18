export function frontendBuild(env: string): void;
export function serverStart(options?: Record<string, unknown>): Promise<unknown>;

export * from './dist/nest-public';
export * from './dist/ai/eval/assertions';
export * as assertions from './dist/ai/eval/assertions';
