import { BadRequestException } from '@nestjs/common';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 返回目标相对根目录的路径。目标等于根目录时返回空字符串，越界时返回 undefined。 */
export function relativeIngestPath(root: string, target: string): string | undefined {
  const child = relative(root, target);
  if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) return undefined;
  return child;
}

/**
 * 优先按工作目录解析请求路径，再尝试相对于知识库根目录解析。
 * 解析符号链接后再次检查归属。目标不存在、不是目录或越界时返回 HTTP 400。
 */
export async function resolveIngestDirectory(
  configuredRoot: string,
  customPath?: string,
): Promise<{ root: string; target: string }> {
  const requested = customPath?.trim();
  const legacyPath = requested ? resolve(process.cwd(), requested) : configuredRoot;
  const candidate = requested && relativeIngestPath(configuredRoot, legacyPath) === undefined
    ? resolve(configuredRoot, requested) : legacyPath;

  if (relativeIngestPath(configuredRoot, candidate) !== undefined) {
    try {
      const root = await realpath(configuredRoot);
      const target = await realpath(candidate);
      if (relativeIngestPath(root, target) !== undefined && (await stat(target)).isDirectory()) {
        return { root, target };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new BadRequestException('Invalid RAG ingestion directory');
}
