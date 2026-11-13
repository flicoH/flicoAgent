const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { ConfigService } = require('../../dist/config/config.service');
const { DatabaseProvider } = require('../../dist/extend/database.provider');

describe('Nest 配置与全局注入', () => {
  let originalCwd, originalEnv, fixture;

  function writeConfig(filename, config) {
    fs.writeFileSync(path.join(fixture, 'config', filename), `module.exports = ${JSON.stringify(config)};`);
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = process.env.__ENV;
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-'));
    fs.mkdirSync(path.join(fixture, 'config'));
    process.chdir(fixture);
    process.env.__ENV = 'local';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnv === undefined) {
      delete process.env.__ENV;
    } else {
      process.env.__ENV = originalEnv;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('按框架默认、业务默认、环境、options 的顺序浅合并', () => {
    writeConfig('config.default.js', {
      name: 'business', age: 40, homePage: '/default',
      db: { client: 'mysql', connection: { host: 'default' } },
    });
    writeConfig('config.local.js', {
      name: 'local', age: 41, homePage: '/local', db: { client: 'mysql' },
    });
    const config = new ConfigService({ name: 'options', homePage: '/options' });
    assert.strictEqual(config.get('name'), 'options');
    assert.strictEqual(config.get('homePage'), '/options');
    assert.strictEqual(config.get('age'), 41);
    assert.deepStrictEqual(config.get('db'), { client: 'mysql' });
    assert.strictEqual(config.get('missing'), undefined);
  });

  for (const [env, filename, predicate] of [
    ['local', 'config.local.js', 'isLocal'],
    ['beta', 'config.beta.js', 'isBeta'],
    ['production', 'config.prod.js', 'isProduction'],
  ]) {
    it(`__ENV=${env} 加载 ${filename}`, () => {
      process.env.__ENV = env;
      writeConfig(filename, { name: env });
      const config = new ConfigService({});
      assert.strictEqual(config.get('name'), env);
      for (const method of ['isLocal', 'isBeta', 'isProduction']) {
        assert.strictEqual(config[method](), method === predicate);
      }
    });
  }

  it('未指定环境时使用 local，保留框架默认配置', () => {
    delete process.env.__ENV;
    writeConfig('config.local.js', { homePage: '/local' });
    const config = new ConfigService({});
    assert.strictEqual(config.isLocal(), true);
    assert.strictEqual(config.get('homePage'), '/local');
    assert.strictEqual(config.get('age'), 32);
  });

  it('业务默认与环境文件均缺失时仍可使用框架默认配置', () => {
    const config = new ConfigService({});
    assert.strictEqual(config.get('name'), 'flicoH');
    assert.strictEqual(config.get('db'), undefined);
  });

  it('已有配置文件引用缺失依赖时抛出原始错误', () => {
    fs.writeFileSync(path.join(fixture, 'config/config.default.js'), "require('./missing-dependency');");
    assert.throws(() => new ConfigService({}), /missing-dependency/);
  });

  it('ExtendModule 无需导入 ConfigModule 即可注入全局配置，无 db 时不创建 knex', async () => {
    const app = await NestFactory.createApplicationContext(AppModule.register({ name: 'injected' }), { logger: false });
    try {
      assert.strictEqual(app.get(ConfigService).get('name'), 'injected');
      assert.strictEqual(app.get(DatabaseProvider).knex, undefined);
    } finally {
      await app.close();
    }
  });

  it('DatabaseProvider 使用合并后的 db 创建 knex', async () => {
    writeConfig('config.default.js', { db: { client: 'mysql', connection: { host: 'default' } } });
    writeConfig('config.local.js', { db: { client: 'mysql', connection: { host: 'overlay' } } });
    const app = await NestFactory.createApplicationContext(AppModule.register({}), { logger: false });
    const database = app.get(DatabaseProvider);
    try {
      assert.strictEqual(database.knex.client.config.connection.host, 'overlay');
    } finally {
      await database.knex.destroy();
      await app.close();
    }
  });
});
