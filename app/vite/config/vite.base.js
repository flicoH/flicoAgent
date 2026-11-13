/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2026 huangqinjia(flicoH)。 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-10-08 11:36:49
 * @LastEditors: flicoH
 * @LastEditTime: 2026-10-08 15:56:05
 */
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const vue = require('@vitejs/plugin-vue');
const agentTplPlugin = require('../plugins/agent-tpl-plugin');

function scanEntries() {
  const handleFile = file => ({
    [path.basename(file, '.js')]: path.resolve(file),
  });
  const frameworkEntries = glob
    .sync(path.resolve(__dirname, '../../pages/**/entry.*.js'))
    .reduce((entries, file) => ({ ...entries, ...handleFile(file) }), {});
  const businessEntries = glob
    .sync(path.resolve(process.cwd(), './app/pages/**/entry.*.js'))
    .reduce((entries, file) => ({ ...entries, ...handleFile(file) }), {});

  return {
    ...frameworkEntries,
    ...businessEntries,
  };
}

const allEntries = scanEntries();
const blankModulePath = path.resolve(__dirname, '../libs/blank.js');
const withFallback = file => (fs.existsSync(file) ? file : blankModulePath);
const alias = {
  'vue': require.resolve('vue'),
  '@babel/runtime': path.resolve(process.cwd(), 'node_modules/@babel/runtime'),
  'element-plus/es/locale/lang/zh-cn$': path.resolve(
    process.cwd(),
    'node_modules/element-plus/es/locale/lang/zh-cn.mjs'
  ),
  'element-plus/dist/locale/zh-cn$': path.resolve(
    process.cwd(),
    'node_modules/element-plus/dist/locale/zh-cn.mjs'
  ),
  $agentPages: path.resolve(__dirname, '../../pages'),
  $agentCommon: path.resolve(__dirname, '../../pages/common'),
  $agentWidgets: path.resolve(__dirname, '../../pages/widgets'),
  $agentStore: path.resolve(__dirname, '../../pages/store'),
  $agentAssets: path.resolve(__dirname, '../../pages/assets'),
  $agentHeaderContainer: path.resolve(
    __dirname,
    '../../pages/widgets/header-container/header-container.vue'
  ),
  $agentSiderContainer: path.resolve(
    __dirname,
    '../../pages/widgets/sider-container/sider-container.vue'
  ),
  $agentSchemaTable: path.resolve(
    __dirname,
    '../../pages/widgets/schema-table/schema-table.vue'
  ),
  $agentSchemaForm: path.resolve(
    __dirname,
    '../../pages/widgets/schema-form/schema-form.vue'
  ),
  $agentSchemaSearchBar: path.resolve(
    __dirname,
    '../../pages/widgets/schema-search-bar/schema-search-bar.vue'
  ),
  $agentBoot: path.resolve(__dirname, '../../pages/boot.js'),
  $businessDashBoardRouterConfig: withFallback(
    path.resolve(process.cwd(), './app/pages/dashboard/router.js')
  ),
  $businseeComponentConfig: withFallback(
    path.resolve(
      process.cwd(),
      './app/pages/dashboard/complex-view/schema-view/components/component-config.js'
    )
  ),
  $businseeFormItemConfig: withFallback(
    path.resolve(process.cwd(), './app/pages/widgets/schema-form/form-item-config.js')
  ),
  $businessSearchItem: withFallback(
    path.resolve(process.cwd(), './app/pages/widgets/schema-search-bar/schema-item-config.js')
  ),
};
const baseConfig = {
  plugins: [vue(), agentTplPlugin()],
  resolve: {
    alias,
    dedupe: ['vue', 'element-plus'],
    extensions: ['.js', '.vue', '.less', '.css'],
  },
  css: {
    preprocessorOptions: {
      less: {},
    },
  },
  build: {
    rollupOptions: {
      input: allEntries,
    },
  },
};

module.exports = { allEntries, baseConfig };
