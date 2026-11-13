/*
 * @Author: flicoH huangqinjia
 * @Date: 2026-08-27 16:33:53
 * @LastEditors: flicoH
 * @LastEditTime: 2026-09-14 14:19:30
 * @FilePath: /flicoH-elips/model/index.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
const _ = require('lodash')
const glob = require('glob')
const path = require('path');
const { sep } = path;

const hasMergeKey = item => {
  return item
    && typeof item === 'object'
    && !Array.isArray(item)
    && item.key !== undefined
    && item.key !== null
}

// project 继承 model 的配置
const projceExtenModel = (model, project) => {
  return _.mergeWith({}, model, project, (modelValue, projValue) => {
    // 处理数据合并的特殊情况
    if (Array.isArray(modelValue) && Array.isArray(projValue)) {
      const canMergeByKey = modelValue.every(hasMergeKey) && projValue.every(hasMergeKey)
      if (!canMergeByKey) {
        return _.cloneDeep(projValue)
      }

      let result = []
      // 因为project继承model,所以需要修改处理新增的情况
      // project有键值, model也有 => 修改（重载）
      // project有键值, model没有 => 新增
      // project没有键值, model有 => 保留

      // 处理修改和保留
      for (let i = 0; i < modelValue.length; i++) {
        let modelItem = modelValue[i]
        const projItem = projValue.find(projItem => projItem.key === modelItem.key)
        // 如果project有键值, model也有递归调用修改
        result.push(projItem ? projceExtenModel(modelItem, projItem) : _.cloneDeep(modelItem))

      }
      // 处理新增
      for (let i = 0; i < projValue.length; i++) {
        const projItem = projValue[i]
        const modelItem = modelValue.find(modelItem => modelItem.key === projItem.key)
        if (!modelItem) {
          result.push(_.cloneDeep(projItem))
        }
      }
      return result
    }
  })
}



/**
 * 解析 model 配置，返回组织且集成后的数据结构
 * [{
 *  model:${model},
 *  project:{
 *    proj1Key: ${proj1} 
 *  }
 * }]
 */

module.exports = (app) => {
  const modelList = []

  // 遍历当前文件夹，构建模型数据结构，挂着到modelList
  // const modelPath = path.resolve(app.baseDir, `.${sep}model`)
  const modelPath = path.resolve(process.cwd(), `.${sep}model`)
  const fileList = glob.sync(path.resolve(modelPath, `.${sep}**${sep}**.js`))

  fileList.forEach(file => {
    if (file.indexOf('index.js') > -1) { return }

    //区分配置类型（model/projcet）
    const type = file.indexOf(`${sep}project${sep}`) > -1 ? 'project' : 'model'

    if (type === 'project') {
      const modelKey = file.match(/\/model\/(.*?)\/project\//)?.[1];
      const projectKey = file.match(/\/project\/(.*?)\.js/)?.[1];
      let modeItem = modelList.find(item => item.model?.key === modelKey)
      if (!modeItem) { // 初始化 model 数据结构
        modeItem = {}
        modelList.push(modeItem)
      }
      if (!modeItem.project) { // 初始化 project 数据结构
        modeItem.project = {}
      }
      modeItem.project[projectKey] = require(path.resolve(file))
      modeItem.project[projectKey].key = projectKey // 注入projectKey
      modeItem.project[projectKey].modelKey = modelKey // 注入modelKey
    }

    if (type === 'model') {
      const modelKey = file.match(/\/model\/(.*?)\/model\.js/)?.[1];

      let modeItem = modelList.find(item => item.model === modelKey)
      if (!modeItem) { // 初始化 model 数据结构
        modeItem = {}
        modelList.push(modeItem)
      }
      modeItem.model = require(path.resolve(file))
      modeItem.model.key = modelKey // 注入modelKey
    }

    // 数据进一步整理： project => 继承 model 的配置
    modelList.forEach(item => {
      const { model, project } = item

      for (const key in project) {
        project[key] = projceExtenModel(model, project[key])
      }
    })
  })
  // console.log(JSON.stringify(modelList))
  return modelList
}
