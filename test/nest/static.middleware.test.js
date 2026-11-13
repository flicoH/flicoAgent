const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { agentModule } = require('../../dist/agent.module');

describe('站点根静态兜底（不启动服务）', () => {
  const root = path.resolve(__dirname, '../..');
  let fixture, originalCwd, middleware;

  beforeEach(() => {
    originalCwd = process.cwd();
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-static-'));
    const publicPath = path.join(fixture, 'app/public');
    fs.mkdirSync(path.join(publicPath, 'static'), { recursive: true });
    fs.mkdirSync(path.join(publicPath, 'dist/prod/js'), { recursive: true });
    fs.mkdirSync(path.join(publicPath, 'api/ai/trace'), { recursive: true });
    fs.writeFileSync(path.join(publicPath, 'static/logo.png'), 'business-logo');
    fs.writeFileSync(path.join(publicPath, 'static/business-only.txt'), 'business-only');
    fs.writeFileSync(path.join(publicPath, 'dist/prod/js/example.js'), 'window.STATIC_FIXTURE = true;');
    fs.writeFileSync(path.join(publicPath, 'api/ai/trace/run-id'), 'private');
    process.chdir(fixture);
    middleware = [];
    agentModule.configureStatic({
      getHttpAdapter: () => ({ getInstance: () => ({ use: handler => middleware.push(handler) }) }),
    });
    assert.strictEqual(middleware.length, 2);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  // 使用真实 express.static + 文件流；响应写入内存，不创建 HTTP 服务或 socket。
  function request(url, method = 'GET') {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const headers = new Map();
      const req = { method, url, originalUrl: url, headers: {} };
      const res = new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      });
      res.statusCode = 200;
      res.finished = false;
      res.setHeader = (key, value) => headers.set(key.toLowerCase(), value);
      res.getHeader = key => headers.get(key.toLowerCase());
      res.getHeaderNames = () => [...headers.keys()];
      res.removeHeader = key => headers.delete(key.toLowerCase());
      const result = next => ({ next, status: res.statusCode, body: Buffer.concat(chunks), headers });
      res.on('finish', () => { res.finished = true; resolve(result(false)); });
      res.on('error', reject);
      let index = 0;
      function next(error) {
        if (error) return reject(error);
        const handler = middleware[index++];
        if (!handler) return resolve(result(true));
        handler(req, res, next);
      }
      next();
    });
  }

  it('/static/logo.png 由框架根读取，同名业务文件不覆盖框架文件', async () => {
    const response = await request('/static/logo.png');
    assert.strictEqual(response.next, false);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, fs.readFileSync(path.join(root, 'app/public/static/logo.png')));
    assert(response.headers.get('content-type').startsWith('image/png'));
  });

  it('框架没有的静态文件继续从业务根读取', async () => {
    const response = await request('/static/business-only.txt');
    assert.strictEqual(response.next, false);
    assert.strictEqual(response.body.toString(), 'business-only');
  });

  it('/dist/prod/js/* 直接从业务站点根提供，不限于 /static 前缀', async () => {
    const response = await request('/dist/prod/js/example.js?v=1');
    assert.strictEqual(response.next, false);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.toString(), 'window.STATIC_FIXTURE = true;');
  });

  it('两处均不存在的文件调用 next，不产生响应', async () => {
    const response = await request('/missing/static-file.js');
    assert.strictEqual(response.next, true);
    assert.strictEqual(response.body.length, 0);
    assert.strictEqual(response.headers.size, 0);
  });

  it('目录路径不 301 重定向、不补尾斜杠，继续 next', async () => {
    for (const url of ['/static', '/static/', '/dist/prod/js']) {
      const response = await request(url);
      assert.strictEqual(response.next, true, url);
      assert.strictEqual(response.headers.has('location'), false);
      assert.strictEqual(response.body.length, 0);
    }
  });

  it('API 和 View 路径没有对应文件时继续交给 Nest 路由', async () => {
    for (const url of ['/api/project/list', '/view/dashboard/schema', '/api/ai/trace/run-id', '/%61pi/ai/trace/run-id']) {
      const response = await request(url);
      assert.strictEqual(response.next, true);
      assert.strictEqual(response.headers.size, 0);
    }
  });

  it('非 GET/HEAD 请求继续 next', async () => {
    const response = await request('/static/logo.png', 'POST');
    assert.strictEqual(response.next, true);
    assert.strictEqual(response.body.length, 0);
  });

  it('HEAD 返回资源头且不写文件正文', async () => {
    const response = await request('/static/business-only.txt', 'HEAD');
    assert.strictEqual(response.next, false);
    assert.strictEqual(response.body.length, 0);
    assert.strictEqual(response.headers.get('content-length'), Buffer.byteLength('business-only'));
  });
});
