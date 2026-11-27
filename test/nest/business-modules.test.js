const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ElpisModule } = require('../../dist/elpis.module');
const { FallbackModule } = require('../../dist/modules/fallback/fallback.module');
const { FallbackController } = require('../../dist/modules/fallback/fallback.controller');

describe('business module wiring', () => {
  it('ElpisModule.register 扫描业务 dist 模块且 FallbackModule 最后', () => {
    const originalCwd = process.cwd();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-modules-'));
    try {
      // 自带构建产物夹具，测试可在独立 checkout 中复现。
      const modules = path.join(fixture, 'dist/modules');
      fs.mkdirSync(modules, { recursive: true });
      const nest = JSON.stringify(require.resolve('@nestjs/common'));
      fs.writeFileSync(path.join(modules, 'fixture.module.js'),
        `class FixtureModule {}; require(${nest}).Module({ providers: [] })(FixtureModule); module.exports = { FixtureModule };`);
      process.chdir(fixture);
      const imports = ElpisModule.register().imports;
      assert.deepStrictEqual(
        imports.map(item => item.name),
        ['AiModule', 'ExtendModule', 'ProjectModule', 'ViewModule', 'FixtureModule', 'FallbackModule'],
      );
      assert.strictEqual(imports.at(-1), FallbackModule);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('框架 cwd 不扫描自身 dist/modules，源码不硬编码业务模块', () => {
    assert.deepStrictEqual(
      ElpisModule.register().imports.map(item => item.name),
      ['AiModule', 'ExtendModule', 'ProjectModule', 'ViewModule', 'FallbackModule'],
    );
    const source = fs.readFileSync(path.resolve(__dirname, '../../app/elpis.module.ts'), 'utf8');
    for (const forbidden of ['loadDemoModule', 'AuthModule', 'UserModule', 'ProductModule', 'HealthModule']) {
      assert.strictEqual(source.includes(forbidden), false);
    }
    assert(source.includes("'dist/modules'"));
    assert(source.includes("endsWith('.module.js')"));
  });

  it('FallbackController 保留 GET * 的 302 首页重定向', () => {
    assert.strictEqual(Reflect.getMetadata('path', FallbackController.prototype.redirectToHome), '*');
    assert.deepStrictEqual(
      new FallbackController({ get: key => key === 'homePage' ? '/view/project-list' : undefined }).redirectToHome(),
      { url: '/view/project-list', statusCode: 302 },
    );
  });

  it('main 通过全局 useGlobalInterceptors 注册 ProjKeyInterceptor', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../app/main.ts'), 'utf8');
    assert(source.includes('app.useGlobalInterceptors(new ProjKeyInterceptor());'));
  });
});
