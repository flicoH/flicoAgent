import { Controller, Get, Query } from '@nestjs/common';
import { BaseController } from '../../common/base/base.controller';
import { GetListDto } from './dto/get-list.dto';
import { GetProjectDto } from './dto/get-project.dto';
import { ProjectService } from './project.service';

@Controller('api/project')
export class ProjectController extends BaseController {
  constructor(private readonly projects: ProjectService) {
    super();
  }

  @Get()
  async get(@Query() query: GetProjectDto) {
    const projConfig = await this.projects.get(query.proj_key);
    if (!projConfig) {
      return this.fail('获取项目异常', 50000);
    }
    return this.success(projConfig);
  }

  @Get('list')
  async getList(@Query() query: GetListDto) {
    const projectList = await this.projects.getList({ projKey: query.proj_key });
    const result = projectList.map(({ modelKey, key, name, desc, homePage }) => ({
      modelKey, key, name, desc, homePage,
    }));
    return this.success(result);
  }

  @Get('model_list')
  async getModelList() {
    const modelList = await this.projects.getModelList();
    const result = modelList.map(({ model, project }) => {
      const { key, name, desc } = model;
      const dtoProject = Object.keys(project).reduce<Record<string, unknown>>((items, projKey) => {
        const { key, name, desc, homePage } = project[projKey];
        items[projKey] = { key, name, desc, homePage };
        return items;
      }, {});
      return {
        model: { key, name, desc },
        project: dtoProject,
      };
    });
    return this.success(result);
  }
}
