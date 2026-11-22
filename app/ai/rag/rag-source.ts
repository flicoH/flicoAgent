import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type Knex from 'knex';
import type { ConfigService } from '../../config/config.service';
import { requireMysqlConnection } from '../store/internal/load-store-config';
import { resolveRagFixturesPath } from './internal/load-rag-config';

export const RAG_SOURCE = Symbol('RAG_SOURCE');

interface SourceDocument {
  docId: string;
  filePath?: string;
  read(): Promise<string>;
}

export interface RagSource {
  key: string;
  meta: { source: 'file' | 'mysql'; collection?: string };
  documents(): Promise<SourceDocument[]>;
}

export class RagDirectoryNotFound extends Error {
  readonly code = 'ENOENT';
}

const supportedExtensions = ['.md', '.markdown', '.txt', '.json'];

async function scanTextFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await scanTextFiles(path));
    } else if (entry.isFile() && supportedExtensions.some(ext => entry.name.toLowerCase().endsWith(ext))) {
      files.push(path);
    }
  }
  return files;
}

async function readSourceFile(filePath: string): Promise<string> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Source is not a regular file');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export function directoryRagSource(directory: string): RagSource {
  const key = resolve(directory);
  return {
    key,
    meta: { source: 'file' },
    async documents() {
      const paths = await scanTextFiles(key).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && error.path === key) {
          throw new RagDirectoryNotFound('RAG source directory not found', { cause: error });
        }
        throw error;
      });
      return paths.sort().map(filePath => ({
        docId: relative(key, filePath), filePath, read: () => readSourceFile(filePath),
      }));
    },
  };
}

export function resolveRagSource(config: ConfigService, connection?: Knex): RagSource {
  const options = config.get<{ driver?: string; collection?: string }>('ai.rag.source');
  if (!options?.driver || options.driver === 'file') return directoryRagSource(resolveRagFixturesPath(config));
  if (options.driver !== 'mysql') throw new Error('Unsupported ai.rag.source.driver');

  const collection = options.collection ?? 'default';
  if (typeof collection !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(collection)) {
    throw new Error('Invalid ai.rag.source.collection');
  }
  const database = requireMysqlConnection(connection, 'ai.rag.source');
  return {
    key: 'mysql:' + collection,
    meta: { source: 'mysql', collection },
    async documents() {
      const rows = await database<{ doc_id: string; body: string }>('flico_rag_documents')
        .where('collection', collection).select('doc_id', 'body').orderBy('doc_id');
      return rows.map(({ doc_id, body }) => ({ docId: doc_id, read: async () => body }));
    },
  };
}
