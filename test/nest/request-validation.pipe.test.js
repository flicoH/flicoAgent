const assert = require('assert');
const { IsDefined, IsString, IsNumber, IsArray, ValidateIf, ValidateNested } = require('class-validator');
const { Type } = require('class-transformer');
const { RequestValidationPipe } = require('../../dist/common/validation/request-validation.pipe');
const { HttpExceptionFilter } = require('../../dist/common/filters/http-exception.filter');

// 仅测试 DTO 模式，不注册业务 Controller 或服务。
class ProductBodyDto {}
IsDefined()(ProductBodyDto.prototype, 'product_name');
IsString()(ProductBodyDto.prototype, 'product_name');
ValidateIf((_object, value) => value !== undefined)(ProductBodyDto.prototype, 'inventory');
IsNumber()(ProductBodyDto.prototype, 'inventory');

class ListQueryDto {}
for (const field of ['page', 'size']) {
  IsDefined()(ListQueryDto.prototype, field);
  IsString()(ListQueryDto.prototype, field);
}

class BatchBodyDto {}
IsArray()(BatchBodyDto.prototype, 'items');
ValidateNested({ each: true })(BatchBodyDto.prototype, 'items');
Type(() => ProductBodyDto)(BatchBodyDto.prototype, 'items');

describe('query/body 统一参数质检（不启动服务）', () => {
  const pipe = new RequestValidationPipe();

  function transform(value, type = 'body', metatype = ProductBodyDto) {
    return pipe.transform(value, { type, metatype });
  }

  async function failure(value, type = 'body', metatype = ProductBodyDto) {
    let exception;
    try {
      await transform(value, type, metatype);
    } catch (error) {
      exception = error;
    }
    assert(exception, '非法参数必须失败');
    let result;
    const filter = new HttpExceptionFilter({ get: () => undefined }, { httpAdapter: {
      isHeadersSent: () => false,
      reply(_response, body, status) { result = { body, status }; },
    } }, { logger: { error() { assert.fail('442 不应被当作 50000'); } } });
    filter.catch(exception, { getArgByIndex: () => ({}) });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.success, false);
    assert.strictEqual(result.body.code, 442);
    assert(result.body.message.startsWith('request validate fail: '));
    assert(result.body.message.length > 'request validate fail: '.length);
    assert.deepStrictEqual(Object.keys(result.body), ['success', 'message', 'code']);
    return result.body;
  }

  it('body 必填字符串缺失、null 或类型不正确均返回 442', async () => {
    for (const value of [{}, { product_name: null }, { product_name: 1 }, undefined]) {
      const body = await failure(value);
      assert(body.message.includes('product_name'));
    }
  });

  it('body number 严格区分数字与字符串，不隐式转换', async () => {
    const body = await transform({ product_name: '商品', inventory: 12 });
    assert(body instanceof ProductBodyDto);
    assert.strictEqual(body.inventory, 12);
    for (const inventory of ['12', null, true]) {
      const error = await failure({ product_name: '商品', inventory });
      assert(error.message.includes('inventory'));
    }
  });

  it('可选字段可省略，JSON schema 的空字符串仍为合法 string', async () => {
    const body = await transform({ product_name: '' });
    assert.strictEqual(body.product_name, '');
    assert.strictEqual(body.inventory, undefined);
  });

  it('query 中 page/size 保留数字文本，缺失或非字符串返回 442', async () => {
    const query = await transform({ page: '1', size: '10' }, 'query', ListQueryDto);
    assert(query instanceof ListQueryDto);
    assert.strictEqual(query.page, '1');
    assert.strictEqual(query.size, '10');
    await failure({ page: '1' }, 'query', ListQueryDto);
    await failure({ page: 1, size: '10' }, 'query', ListQueryDto);
  });

  it('query 和 body 均去除额外字段', async () => {
    const body = await transform({ product_name: '商品', extra: 'removed' });
    const query = await transform({ page: '1', size: '10', extra: 'removed' }, 'query', ListQueryDto);
    assert.strictEqual(Object.hasOwn(body, 'extra'), false);
    assert.strictEqual(Object.hasOwn(query, 'extra'), false);
  });

  it('嵌套数组子项的错误展开完整路径，且不回传原始参数', async () => {
    const body = await failure({ items: [{ product_name: '商品', inventory: 'SECRET-body' }] }, 'body', BatchBodyDto);
    assert(body.message.includes('items.0.inventory'));
    assert(!JSON.stringify(body).includes('SECRET-body'));
    const valid = await transform({ items: [{ product_name: '商品', inventory: 1 }] }, 'body', BatchBodyDto);
    assert(valid.items[0] instanceof ProductBodyDto);
  });

  it('未添加校验装饰器的 DTO class 不会静默通过', async () => {
    class UndecoratedDto {}
    await failure({ field: 'value' }, 'body', UndecoratedDto);
  });

  it('query/body 失败状态和响应字段与 1.0 中间件一致', async () => {
    // Koa 中间件已移除，直接验证兼容约定的响应合同。
    for (const [type, metatype, value] of [
      ['query', ListQueryDto, { page: '1' }],
      ['body', ProductBodyDto, { product_name: '商品', inventory: '12' }],
    ]) {
      const body = await failure(value, type, metatype);
      assert.deepStrictEqual({ ...body, message: body.message.split(':')[0] }, {
        success: false, message: 'request validate fail', code: 442,
      });
    }
  });
});
