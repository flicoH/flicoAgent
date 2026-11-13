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
    // 后端启动和断言调用不需要加载 Vite 或扫描前端入口。
    if (env === 'local') {
      return require('./app/vite/dev.js')()
    } else if (env === 'production') {
      return require('./app/vite/prod.js')()
    }
  },

  /**
   * 启动服务
   * @param  options 项目配置，透传给 Nest
   */
  serverStart(options = {}) {
    return require('./dist/main').bootstrap(options)
  }
}

const { APP_GUARD, Reflector, RagModule, RetrieverService } = require('./dist/nest-public')
module.exports.APP_GUARD = APP_GUARD
module.exports.Reflector = Reflector
module.exports.RagModule = RagModule
module.exports.RetrieverService = RetrieverService
