const assert = require('assert');
const { HttpException, NotFoundException, InternalServerErrorException } = require('@nestjs/common');
const { ConfigService } = require('../../dist/config/config.service');
const { HttpExceptionFilter } = require('../../dist/common/filters/http-exception.filter');

describe('全局异常 Filter（不启动服务）', () => {
  let result, response, host, filter, logged;

  beforeEach(() => {
    result = undefined;
    response = { headersSent: false };
    host = {
      switchToHttp: () => ({ getResponse: () => response }),
      getArgByIndex: () => response,
    };
    const httpAdapter = {
      isHeadersSent: target => target.headersSent,
      reply(target, body, status) {
        assert.strictEqual(target, response);
        result = { body, status };
      },
      redirect(target, status, url) {
        assert.strictEqual(target, response);
        result = { status, url };
      },
      end(target) {
        assert.strictEqual(target, response);
        result = { ended: true };
      },
    };
    logged = [];
    filter = new HttpExceptionFilter(
      new ConfigService({ homePage: '/view/project-list' }),
      { httpAdapter },
      { logger: { error: (...args) => logged.push(args) } },
    );
  });

  function expectNetworkError() {
    assert.deepStrictEqual(result, {
      status: 200,
      body: { success: false, code: 50000, message: '网络错误，请稍候重试' },
    });
    assert.strictEqual(logged.length, 1);
  }

  it('未处理 Error 使用 50000 和旧版固定消息，不泄漏内部错误', () => {
    filter.catch(new Error('secret database error'), host);
    expectNetworkError();
  });

  it('未处理的非 Error 抛出值也统一返回', () => {
    for (const exception of ['unexpected', null, { detail: 'internal' }]) {
      logged.length = 0;
      filter.catch(exception, host);
      expectNetworkError();
    }
  });

  it('HTTP 500 异常也统一为 50000', () => {
    filter.catch(new InternalServerErrorException('internal error'), host);
    expectNetworkError();
  });

  it('template not found 按合并 options 后的 ConfigService 首页 302 重定向', () => {
    filter.catch(new Error('template not found: dashboard.tpl'), host);
    assert.deepStrictEqual(result, { status: 302, url: '/view/project-list' });
  });

  it('模板缺失即使由 HttpException 抛出也重定向', () => {
    filter.catch(new NotFoundException('template not found: dashboard.tpl'), host);
    assert.deepStrictEqual(result, { status: 302, url: '/view/project-list' });
  });

  it('已有 442、445、446 业务异常保留 HTTP 200 和原响应对象', () => {
    for (const code of [442, 445, 446]) {
      const body = { success: false, code, message: 'request validate fail: test' };
      filter.catch(new HttpException(body, 200), host);
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body, body);
    }
    assert.strictEqual(logged.length, 0);
  });

  it('普通 HTTP 404 保留原状态和响应', () => {
    const exception = new NotFoundException('Cannot GET /missing');
    filter.catch(exception, host);
    assert.strictEqual(result.status, 404);
    assert.deepStrictEqual(result.body, exception.getResponse());
  });

  it('响应头已发送时结束响应，不再写入 JSON 或重定向', () => {
    response.headersSent = true;
    filter.catch(new Error('template not found: dashboard.tpl'), host);
    assert.deepStrictEqual(result, { ended: true });
  });
});
