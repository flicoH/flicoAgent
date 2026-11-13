const { baseConfig } = require('./config/vite.base');
const prodConfig = require('./config/vite.prod');

module.exports = async () => {
  const vite = await import('vite');
  const config = vite.mergeConfig(baseConfig, prodConfig);
  const result = await vite.build(config);

  console.log(result);

  return result;
};
