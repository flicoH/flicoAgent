/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2026 huangqinjia(flicoH)。 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-05-03 21:49:42
 * @LastEditors: flicoH
 * @LastEditTime: 2026-05-03 22:44:58
 */

/**
 * 日志模块
 * 外部调用: app.logger.info('info') app.logger.error('error')
 */
const log4js = require('log4js');

module.exports = (app) => { 
  let logger;
  if(app.env.isLocal()){
    // 打印日志到控制台
    logger = console;
  }else{
    // 生产环境使用文件日志
    logger = log4js.configure({
      appenders:{
        console:{
          type: 'console'
        },
        // 日志文件切分
        dateFile:{  
          type: 'dateFile',
          filename: './logs/application.log',
          pattern: 'yyyy-MM-dd.log',
          alwaysIncludePattern: true,
          daysToKeep: 30,
          numBackups: 3
        },
      },
      categories:{
        default:{
          appenders:['console', 'dateFile'],
          level: 'trace'
        } 
      }
    });
    logger = log4js.getLogger('dateFile');
  }
  return logger
}

