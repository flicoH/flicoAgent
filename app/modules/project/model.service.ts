import { Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';

const runtimeRequire = createRequire(__filename);

export interface ProjectConfig {
  key: string;
  modelKey: string;
  [key: string]: unknown;
}

export interface ModelEntry {
  model: Record<string, unknown>;
  project: Record<string, ProjectConfig>;
}

@Injectable()
export class ModelService {
  private readonly modelList: ModelEntry[] = runtimeRequire('../../../model/index.js')();

  getModelList(): ModelEntry[] {
    return this.modelList;
  }
}
