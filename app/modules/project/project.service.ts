import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { ModelService, ProjectConfig } from './model.service';

@Injectable()
export class ProjectService {
  constructor(
    private readonly models: ModelService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  get(projKey: string): ProjectConfig | null {
    let projConfig: ProjectConfig | null = null;

    this.models.getModelList().forEach(({ project }) => {
      if (project[projKey]) {
        projConfig = project[projKey];
      }
    });

    if (!projConfig) {
      return null;
    }

    // 沿用 elpis 统一配置机制：从 ConfigService 读取 agentConfig 并动态合并到项目菜单
    const globalAgentConfig = this.config?.get<Record<string, unknown>>('agentConfig')
      ?? this.config?.get<Record<string, unknown>>('ai.agentConfig')
      ?? {};

    const cloned: ProjectConfig = JSON.parse(JSON.stringify(projConfig));
    if (Array.isArray(cloned.menu)) {
      cloned.menu = cloned.menu.map((item: any) => {
        if (item.key === 'project-assistant-chat' || item.agentConfig || item.customConfig?.path === '/agent') {
          return {
            ...item,
            agentConfig: {
              ...(item.agentConfig || {}),
              ...globalAgentConfig,
            },
          };
        }
        return item;
      });
    }

    return cloned;
  }

  getList({ projKey }: { projKey?: string }): ProjectConfig[] {
    return this.models.getModelList().reduce<ProjectConfig[]>((preList, { project }) => {
      if (projKey) {
        if (project[projKey]) {
          preList.push(project[projKey]);
        }
        return preList;
      }

      for (const pKey in project) {
        preList.push(project[pKey]);
      }
      return preList;
    }, []);
  }

  async getModelList(): Promise<ReturnType<ModelService['getModelList']>> {
    return this.models.getModelList();
  }
}
