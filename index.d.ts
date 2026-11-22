import type { BootstrapOptions } from './dist/nest-public';

export function frontendBuild(env: string): void;
export function serverStart(options?: BootstrapOptions): Promise<unknown>;

export * from './dist/nest-public';
export * from './dist/ai/eval/assertions';
export * as assertions from './dist/ai/eval/assertions';
