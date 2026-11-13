const { baseConfig } = require('./config/vite.base');
const devConfig = require('./config/vite.dev');

module.exports = async () => {
  const vite = await import('vite');
  const config = vite.mergeConfig(baseConfig, devConfig);
  const server = await vite.createServer(config);

  await server.listen();
  console.log('http://127.0.0.1:9002');

  return server;
};
