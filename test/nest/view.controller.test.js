const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { match } = require('path-to-regexp');
const { ConfigService } = require('../../dist/config/config.service');
const { ViewController } = require('../../dist/modules/view/view.controller');
const { HttpExceptionFilter } = require('../../dist/common/filters/http-exception.filter');
const { ApiSignGuard } = require('../../dist/common/guards/api-sign.guard');

describe('View 壳（不启动服务）', () => {
  const root = path.resolve(__dirname, '../..');
  const logger = { info() {}, error() {} };
  let fixture, originalCwd, originalEnv, originalLegacyEnv;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = process.env._ENV;
    originalLegacyEnv = process.env.__ENV;
    delete process.env._ENV;
    delete process.env.__ENV;
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-'));
    fs.mkdirSync(path.join(fixture, 'app/public/dist'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'config'));
    fs.writeFileSync(path.join(fixture, 'config/config.default.js'),
      "module.exports = { name: '业务站点', age: 'NOT_A_TEMPLATE_VARIABLE' };");
    fs.writeFileSync(path.join(fixture, 'app/public/shared.tpl'), '<header>shared</header>');
    fs.writeFileSync(path.join(fixture, 'app/public/dist/entry.dashboard.tpl'),
      '{% include "shared.tpl" %}\n<title>{{name}}</title><env>{{env}}</env><project>{{projKey}}</project><options>{{options}}</options><extra>{{age}}</extra>');
    process.chdir(fixture);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env._ENV;
    else process.env._ENV = originalEnv;
    if (originalLegacyEnv === undefined) delete process.env.__ENV;
    else process.env.__ENV = originalLegacyEnv;
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function controller(options = { homePage: '/view/project-list' }) {
    return new ViewController(new ConfigService(options), { logger });
  }

  it('同一 handler 的两条路径匹配单页及多段前端路由，page 只取首段', () => {
    const handler = ViewController.prototype.renderPage;
    const routes = Reflect.getMetadata('path', handler);
    assert.deepStrictEqual(routes, [':page', ':page/{*path}']);
    const prefix = Reflect.getMetadata('path', ViewController);
    const resolveRoute = match(routes.map(route => `/${prefix}/${route}`));
    for (const [url, page] of [
      ['/view/project-list', 'project-list'],
      ['/view/dashboard', 'dashboard'],
      ['/view/dashboard/schema', 'dashboard'],
      ['/view/dashboard/schema/detail', 'dashboard'],
    ]) {
      const route = resolveRoute(url);
      assert(route, url);
      assert.strictEqual(route.params.page, page);
      if (page === 'dashboard') assert(controller().renderPage(route.params.page, 'jd').includes('<project>jd</project>'));
    }
  });

  it('从业务 cwd 读取 .tpl，只提供四个模板变量，name 取合并配置', () => {
    const html = controller().renderPage('dashboard', 'jd');
    assert(html.includes('<title>业务站点</title>'));
    assert(html.includes('<env>local</env>'));
    assert(html.includes('<project>jd</project>'));
    assert.deepStrictEqual(JSON.parse(html.match(/<options>(.*?)<\/options>/)[1].replace(/&quot;/g, '"')), {
      homePage: '/view/project-list', agentConfig: { threadEnabled: true },
    });
    assert(html.includes('<extra></extra>'));
    assert(!html.includes('NOT_A_TEMPLATE_VARIABLE'));
    assert.strictEqual(Reflect.getMetadata('__headers__', ViewController.prototype.renderPage)[0].value, 'text/html; charset=utf-8');
  });

  it('环境优先取 _ENV，兼容旧 __ENV，缺省 local', () => {
    process.env.__ENV = 'beta';
    assert(controller().renderPage('dashboard').includes('<env>beta</env>'));
    process.env._ENV = 'production';
    assert(controller().renderPage('dashboard').includes('<env>production</env>'));
    delete process.env._ENV;
    delete process.env.__ENV;
    assert(controller().renderPage('dashboard').includes('<env>local</env>'));
  });

  it('ConfigService 返回原启动参数，未混入配置默认值', () => {
    const options = { homePage: '/view/project-list' };
    const config = new ConfigService(options);
    assert.strictEqual(config.getBootstrapOptions(), options);
    assert.strictEqual(config.get('name'), '业务站点');
    assert.strictEqual(JSON.stringify(config.getBootstrapOptions()), JSON.stringify(options));
  });

  it('模板缺失抛给现有 Filter，按 ConfigService 首页 302 重定向', () => {
    const config = new ConfigService({ homePage: '/view/project-list' });
    let exception, result;
    try {
      new ViewController(config, { logger }).renderPage('missing');
    } catch (error) {
      exception = error;
    }
    assert(exception.message.includes('template not found'));
    const filter = new HttpExceptionFilter(config, { httpAdapter: {
      isHeadersSent: () => false,
      redirect(_response, status, url) { result = { status, url }; },
    } }, { logger });
    filter.catch(exception, { switchToHttp: () => ({ getResponse: () => ({}) }) });
    assert.deepStrictEqual(result, { status: 302, url: '/view/project-list' });
  });

  it('页面及其前端子路由无需 API 签名', () => {
    const guard = new ApiSignGuard({ get() { assert.fail('页面无需读取验签配置'); } });
    for (const requestPath of ['/view/project-list', '/view/dashboard/schema']) {
      assert.strictEqual(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ path: requestPath, headers: {} }) }) }), true);
    }
  });

  it('只读渲染 Part1 已生成的 demo 模板，保留 9002 脚本地址', function () {
    const demoPath = path.resolve(root, '../elips-demo');
    const pages = ['project-list', 'dashboard'];
    if (!pages.every(page => fs.existsSync(path.join(demoPath, `app/public/dist/entry.${page}.tpl`)))) this.skip();
    process.chdir(demoPath);
    const view = controller({ name: 'demo-view', homePage: '/view/project-list' });
    for (const page of pages) {
      const html = view.renderPage(page, 'jd');
      assert(html.includes('<title>demo-view</title>'));
      assert(html.includes('value="jd"'));
      assert(html.includes('http://127.0.0.1:9002/'));
      assert(!html.includes('{{'));
    }
  });
});
