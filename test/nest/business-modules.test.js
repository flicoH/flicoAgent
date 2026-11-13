const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { agentModule } = require('../../dist/agent.module');
const { FallbackModule } = require('../../dist/modules/fallback/fallback.module');
const { FallbackController } = require('../../dist/modules/fallback/fallback.controller');

describe('business module wiring', () => {
  it('agentModule.register 扫描业务 dist 模块且 FallbackModule 最后', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(path.resolve(__dirname, '../../../elips-demo'));
      const imports = agentModule.register().imports;
      assert.deepStrictEqual(
        imports.map(item => item.name),
        ['ExtendModule', 'ProjectModule', 'ViewModule', 'AuthModule', 'ProductModule', 'UserModule', 'FallbackModule'],
      );
      assert.strictEqual(imports.at(-1), FallbackModule);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('框架 cwd 不扫描自身 dist/modules，源码不硬编码业务模块', () => {
    assert.deepStrictEqual(
      agentModule.register().imports.map(item => item.name),
      ['ExtendModule', 'ProjectModule', 'ViewModule', 'FallbackModule'],
    );
    const source = fs.readFileSync(path.resolve(__dirname, '../../app/agent.module.ts'), 'utf8');
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
