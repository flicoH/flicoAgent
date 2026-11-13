const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigService } = require('../../dist/config/config.service');

describe('启动脚本环境变量兼容（不启动服务）', () => {
  let fixture, originalCwd, currentEnv, legacyEnv;

  beforeEach(() => {
    originalCwd = process.cwd();
    currentEnv = process.env._ENV;
    legacyEnv = process.env.__ENV;
    delete process.env._ENV;
    delete process.env.__ENV;
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-environment-'));
    fs.mkdirSync(path.join(fixture, 'config'));
    for (const [filename, name] of [['local', 'local'], ['beta', 'beta'], ['prod', 'production']]) {
      fs.writeFileSync(path.join(fixture, `config/config.${filename}.js`), `module.exports = { name: '${name}' };`);
    }
    process.chdir(fixture);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (currentEnv === undefined) delete process.env._ENV;
    else process.env._ENV = currentEnv;
    if (legacyEnv === undefined) delete process.env.__ENV;
    else process.env.__ENV = legacyEnv;
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('_ENV=production 选择生产 overlay 和生产 cookie 依据', () => {
    process.env._ENV = 'production';
    const config = new ConfigService({});
    assert.strictEqual(config.get('name'), 'production');
    assert.strictEqual(config.isProduction(), true);
    assert.strictEqual(config.isLocal(), false);
  });

  it('_ENV 优先于旧 __ENV，dev 使用本地配置', () => {
    process.env._ENV = 'local';
    process.env.__ENV = 'production';
    const config = new ConfigService({});
    assert.strictEqual(config.get('name'), 'local');
    assert.strictEqual(config.isLocal(), true);
  });

  it('未设置 _ENV 时继续兼容旧 __ENV', () => {
    process.env.__ENV = 'beta';
    const config = new ConfigService({});
    assert.strictEqual(config.get('name'), 'beta');
    assert.strictEqual(config.isBeta(), true);
  });

  it('均未设置时默认 local', () => {
    const config = new ConfigService({});
    assert.strictEqual(config.isLocal(), true);
    assert.strictEqual(config.get('name'), 'local');
  });
});
