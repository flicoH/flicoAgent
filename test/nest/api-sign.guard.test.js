const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md5 = require('md5');
const { HttpException } = require('@nestjs/common');
const { ConfigService } = require('../../dist/config/config.service');
const { ApiSignGuard } = require('../../dist/common/guards/api-sign.guard');
const { HttpExceptionFilter } = require('../../dist/common/filters/http-exception.filter');

describe('API 验签 Guard（不启动服务）', () => {
  const now = 1800000000000;
  const signKey = 'klx05hb3n1c9ujp8uhxbs2ikkiowp212';
  let originalNow;

  beforeEach(() => {
    originalNow = Date.now;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  function headers(st = String(now)) {
    return { s_t: st, s_sign: md5(`${signKey}_${st}`).toLowerCase() };
  }

  function context(requestPath = '/api/project/list', requestHeaders = {}) {
    return { switchToHttp: () => ({ getRequest: () => ({ path: requestPath, headers: requestHeaders }) }) };
  }

  function guard(whiteList = []) {
    return new ApiSignGuard({
      get(key) {
        assert.strictEqual(key, 'apiSignVerify.whiteList');
        return whiteList;
      },
    });
  }

  function expect445(requestHeaders, instance = guard(), requestPath = '/api/project/list') {
    let exception;
    assert.throws(() => instance.canActivate(context(requestPath, requestHeaders)), error => {
      exception = error;
      assert(error instanceof HttpException);
      assert.strictEqual(error.getStatus(), 200);
      assert.deepStrictEqual(error.getResponse(), {
        success: false, message: 'signature not correct or api timeout!!', code: 445,
      });
      return true;
    });
    return exception;
  }

  it('施工单密钥生成的 md5 签名通过，签名大小写不敏感', () => {
    const requestHeaders = headers();
    assert.strictEqual(guard().canActivate(context(undefined, requestHeaders)), true);
    requestHeaders.s_sign = requestHeaders.s_sign.toUpperCase();
    assert.strictEqual(guard().canActivate(context(undefined, requestHeaders)), true);
  });

  it('缺少、空值及非字符串签名头返回 445', () => {
    for (const requestHeaders of [
      {}, { s_t: String(now) }, { s_sign: headers().s_sign },
      { ...headers(), s_t: '' }, { ...headers(), s_sign: '' },
      { ...headers(), s_t: [String(now)] }, { ...headers(), s_sign: ['invalid'] },
    ]) expect445(requestHeaders);
  });

  it('错误签名与旧密钥签名均返回 445', () => {
    expect445({ ...headers(), s_sign: 'wrong' });
    expect445({ ...headers(), s_sign: md5(`65a8e27d8879283831b664bd8b7f0ad4_${now}`) });
  });

  it('恰好 600000ms 仍通过，超过 1ms 即返回 445', () => {
    assert.strictEqual(guard().canActivate(context(undefined, headers(String(now - 600000)))), true);
    expect445(headers(String(now - 600001)));
  });

  it('保留 1.0 单向超时计算，未来时间戳的正确签名通过', () => {
    assert.strictEqual(guard().canActivate(context(undefined, headers(String(now + 1000)))), true);
  });

  it('仅 /api/* 校验，页面和相似前缀路径跳过', () => {
    for (const requestPath of ['/', '/view/project-list', '/api', '/apix/test', '/other/api/test']) {
      assert.strictEqual(guard().canActivate(context(requestPath)), true);
    }
    expect445({}, guard(), '/api/project');
  });

  it('白名单路径免签，其他 API 和白名单子路径仍校验', () => {
    const instance = guard(['/api/login']);
    assert.strictEqual(instance.canActivate(context('/api/login')), true);
    expect445({}, instance, '/api/project/list');
    expect445({}, instance, '/api/login/child');
  });

  it('未配置白名单时默认继续校验', () => {
    expect445({}, guard(undefined));
    expect445({}, new ApiSignGuard({ get: () => undefined }));
  });

  it('已有 ConfigService 从业务嵌套配置读取白名单并使 Guard 放行', () => {
    const originalCwd = process.cwd();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sign-'));
    try {
      fs.mkdirSync(path.join(fixture, 'config'));
      fs.writeFileSync(path.join(fixture, 'config/config.default.js'),
        "module.exports = { apiSignVerify: { whiteList: ['/api/login'] } };");
      process.chdir(fixture);
      const config = new ConfigService({ name: 'sign-test' });
      assert.deepStrictEqual(config.get('apiSignVerify.whiteList'), ['/api/login']);
      assert.deepStrictEqual(config.get('apiSignVerify'), { whiteList: ['/api/login'] });
      assert.strictEqual(config.get('name'), 'sign-test');
      assert.strictEqual(config.get('apiSignVerify.missing'), undefined);
      assert.strictEqual(config.get('missing.child'), undefined);
      const instance = new ApiSignGuard(config);
      assert.strictEqual(instance.canActivate(context('/api/login')), true);
      expect445({}, instance);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('实际 Guard 的 445 经现有 Filter 后保持 HTTP 200 和原始响应', () => {
    const exception = expect445({});
    const response = {};
    let result;
    const filter = new HttpExceptionFilter({ get: () => undefined }, { httpAdapter: {
      isHeadersSent: () => false,
      reply(target, body, status) {
        assert.strictEqual(target, response);
        result = { body, status };
      },
    } }, { logger: { error() { assert.fail('445 不应作为未处理异常记录'); } } });
    filter.catch(exception, { getArgByIndex: () => response });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, exception.getResponse());
  });
});
