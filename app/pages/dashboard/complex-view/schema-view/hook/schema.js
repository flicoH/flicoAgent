/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-02 17:48:33
 * @LastEditors: flicoH
 */
import { ref, watch, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useMenuStore } from '$elpisStore/menu'

export const useSchema = () => {
  const route = useRoute()
  const menuStore = useMenuStore()

  const api = ref('')
  const tableSchema = ref({})
  const tableConfig = ref()

  const searchSchema = ref({})
  const searchConfig = ref()

  const components = ref()


  // 构造schemaConfig相关配置，输送给schemaView解析
  const buildData = () => {
    // TODO: 实现构建schema数据的逻辑
    const { key, sider_key: siderKey } = route.query

    const menuItem = menuStore.findMenuItem({
      key: 'key',
      value: siderKey ?? key
    })
    if (menuItem && menuItem.schemaConfig) {
      const { schemaConfig: sConfig } = menuItem
      const configSchema = JSON.parse(JSON.stringify(sConfig.schema))

      api.value = sConfig.api ?? ''

      tableSchema.value = {}
      tableConfig.value = undefined

      searchSchema.value = {}
      searchConfig.value = undefined

      components.value = undefined


      nextTick(() => {
        // 构造 tableSchema 和 tableConfig
        tableSchema.value = buildDtoSchema(configSchema, 'table')
        tableConfig.value = configSchema.tableConfig
        // 构造 searchSchema 和 searchConfig
        const dtoSearchSchema = buildDtoSchema(configSchema, 'search')
        for (const key in dtoSearchSchema.properties) {
          if (route.query[key] != undefined) {
            dtoSearchSchema.properties[key].option.default = route.query[key]
          }
        }
        searchSchema.value = dtoSearchSchema
        searchConfig.value = configSchema.searchConfig

        // 构造 components = {comKey:{schema,config}
        const { componentConfig } = configSchema

        if (componentConfig && Object.keys(componentConfig).length > 0) {
          const dtoComponents = {}
          
          for (const comName in componentConfig) {
            dtoComponents[comName] = {
              schema: buildDtoSchema(configSchema, comName),
              config: componentConfig[comName]
            }
          }
          components.value = dtoComponents
        }
      })

    }
  }

  // 通用构建schema方法 （清除噪音）
  const buildDtoSchema = (_schema, comName) => {
    if (!_schema?.properties) { return {} }
    const dtoSchema = {
      type: 'object',
      properties: {}
    }

    // 提出有效 schema 字段信息
    for (const key in _schema.properties) {
      const props = _schema.properties[key]
      if (props[`${comName}Option`]) {
        let dtoProps = {}
        // 提出props中不包含Option的字段信息，存放到dtoProps中
        for (const pKey in props) {
          if (pKey.indexOf('Option') < 0) {
            dtoProps[pKey] = props[pKey]
          }
        }
        // 处理comName option
        dtoProps = Object.assign({}, dtoProps, { option: props[`${comName}Option`] })
        
        // 处理 required 字段
        const { required } = _schema.properties
        if (required && required.find(pk => pk === key)){
          dtoProps.option.required = true
        }

        dtoSchema.properties[key] = dtoProps

      }
    }
    return dtoSchema
  }

  watch([
    () => route.query.key,
    () => route.query.sider_key,
    () => menuStore.menuList
  ], () => {
    buildData()
  }, {
    deep: true
  })

  onMounted(() => {
    buildData()
  })

  return {
    api,
    tableSchema,
    tableConfig,
    searchSchema,
    searchConfig,
    components,
  }
}
