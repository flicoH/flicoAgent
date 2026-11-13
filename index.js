/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2026 huangqinjia(flicoH)。 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-04-25 14:58:41
 * @LastEditors: flicoH
 * @LastEditTime: 2026-09-15 11:08:41
 */

// 引入编译后的 Nest 启动入口
const { bootstrap } = require('./dist/main')
// 引入前端工程化方法
const FEBuildDev = require('./app/vite/dev.js')
const FEBuildProd = require('./app/vite/prod.js')
// 引入评测断言纯函数
const assertions = require('./dist/ai/eval/assertions')


module.exports = {
  ...assertions,
  assertions,

  /** 
   * 编辑构建前端工程
   * @param {string} evn 环境 dev/prod
   */
  frontendBuild(env) {
    if (env === 'local') {
      FEBuildDev()
    } else if (env === 'production') {
      FEBuildProd()
    }
  },

  /**
   * 启动服务
   * @param  options 项目配置，透传给 Nest
   */
  serverStart(options = {}) {
    return bootstrap(options)
  }
}
