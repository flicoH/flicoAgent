const assert = require('assert');
const { HttpException, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { HttpExceptionFilter } = require('../../dist/common/filters/http-exception.filter');
const { ProjKeyInterceptor } = require('../../dist/common/interceptors/proj-key.interceptor');
const { RequestValidationPipe } = require('../../dist/common/validation/request-validation.pipe');
const { bootstrap } = require('../../dist/main');
const { GetProjectDto } = require('../../dist/modules/project/dto/get-project.dto');
const { GetListDto } = require('../../dist/modules/project/dto/get-list.dto');
const { ProjectController } = require('../../dist/modules/project/project.controller');

describe('Project DTO 与全局 442 校验', () => {
  it('按 proj_key 只返回对应项目', () => {
    const { ProjectService } = require('../../dist/modules/project/project.service');
    const a = { key: 'a' };
    const b = { key: 'b' };
    const projects = new ProjectService({ getModelList: () => [{ project: { a, b } }] });
    assert.deepStrictEqual(projects.getList({ projKey: 'a' }), [a]);
    assert.deepStrictEqual(projects.getList({ projKey: 'missing' }), []);
    assert.deepStrictEqual(projects.getList({}), [a, b]);
  });

  let pipe;

  before(async () => {
    const originalCreate = NestFactory.create;
    const staticMiddleware = [];
    const app = {
      getHttpAdapter: () => ({ getInstance: () => ({ use: value => staticMiddleware.push(value) }) }),
      useGlobalPipes(value) {
        assert.strictEqual(staticMiddleware.length, 2, 'create 后先挂两份静态兜底');
        pipe = value;
      },
      useGlobalInterceptors(value) {
        assert(value instanceof ProjKeyInterceptor, '必须保留全局 ProjKeyInterceptor');
      },
      async listen(port) {
        assert.strictEqual(port, 8080);
        assert(pipe instanceof ValidationPipe, '必须在 listen 前注册全局管道');
        assert(pipe instanceof RequestValidationPipe, '必须注册 query/body 共用管道');
      },
    };
    NestFactory.create = async () => app;
    try {
      assert.strictEqual(await bootstrap({}), app);
    } finally {
      NestFactory.create = originalCreate;
    }
  });

  function transform(value, metatype) {
    return pipe.transform(value, { type: 'query', metatype });
  }

  async function expect442(value, dto) {
    let exception;
    try {
      await transform(value, dto);
    } catch (error) {
      exception = error;
    }
    assert(exception instanceof HttpException, '非法查询必须抛出 HttpException');
    let result;
    const response = {};
    const filter = new HttpExceptionFilter({ get: () => undefined }, { httpAdapter: {
      isHeadersSent: () => false,
      reply(target, body, status) {
        assert.strictEqual(target, response);
        result = { status, body };
      },
    } }, { logger: { error() {} } });
    filter.catch(exception, { getArgByIndex: () => response });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(Object.keys(result.body), ['success', 'message', 'code']);
    assert.strictEqual(result.body.success, false);
    assert.strictEqual(result.body.code, 442);
    assert(result.body.message.startsWith('request validate fail:'));
    assert(result.body.message.includes('proj_key'));
  }

  it('Controller 全量 query 使用两个 DTO class', () => {
    assert.strictEqual(Reflect.getMetadata('design:paramtypes', ProjectController.prototype, 'get')[0], GetProjectDto);
    assert.strictEqual(Reflect.getMetadata('design:paramtypes', ProjectController.prototype, 'getList')[0], GetListDto);
  });

  it('get 缺少 proj_key 返回 HTTP 200 + 442', async () => {
    await expect442({}, GetProjectDto);
    await expect442({ projKey: 'jd' }, GetProjectDto);
  });

  it('get 的 proj_key 必须是字符串', async () => {
    for (const proj_key of [null, 123, true, ['jd', 'pdd'], { key: 'jd' }]) {
      await expect442({ proj_key }, GetProjectDto);
    }
  });

  it('合法 get query 转为 DTO 实例并删除额外字段', async () => {
    const query = await transform({ proj_key: 'jd', extra: 'removed' }, GetProjectDto);
    assert(query instanceof GetProjectDto);
    assert.strictEqual(query.proj_key, 'jd');
    assert.strictEqual(Object.hasOwn(query, 'extra'), false);
  });

  it('list 可省略 proj_key，且转换为 DTO 实例', async () => {
    const query = await transform({}, GetListDto);
    assert(query instanceof GetListDto);
    assert.strictEqual(query.proj_key, undefined);
  });

  it('list 提供 proj_key 时必须是字符串', async () => {
    for (const proj_key of [123, true, ['jd', 'pdd'], { key: 'jd' }]) {
      await expect442({ proj_key }, GetListDto);
    }
    const query = await transform({ proj_key: 'jd', extra: 'removed' }, GetListDto);
    assert.strictEqual(query.proj_key, 'jd');
    assert.strictEqual(Object.hasOwn(query, 'extra'), false);
  });
});
