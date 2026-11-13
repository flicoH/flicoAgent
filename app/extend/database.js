/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-10-04 01:22:42
 * @LastEditors: flicoH
 */
module.exports = (app) => {
  const { db: dbConfig } = app.config;
  if (!dbConfig) { return; }
  return require('knex')(dbConfig)

}