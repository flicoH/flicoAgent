<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-07 11:19:26
 * @LastEditors: flicoH
-->
<template>
  <el-form
    v-if="schema && schema.properties"
    :inline="true"
    class="schema-search-bar"
  >
    <el-row justify="space-between">
      <el-col :span="18">
        <!-- 组件区域 -->
        <el-form-item
          v-for="(schemaItem, key) in schema.properties"
          :key="key"
          :label="schemaItem.label"
        >
          <!-- 渲染表单组件 -->
          <component
            ref="searchComList"
            :is="SearchItemConfig[schemaItem.option?.comType].component"
            :schemaKey="key"
            :schema="schemaItem"
            @loaded="handleChildLoaded"
          ></component>
        </el-form-item>
      </el-col>
      <el-col :span="6">
        <!-- 操作区域 -->
        <el-form-item>
          <el-button type="primary" plain class="search-btn" @click="search"
            >搜索</el-button
          >
          <el-button plain class="reset-btn" @click="reset">重置</el-button>
        </el-form-item>
      </el-col>
    </el-row>
  </el-form>
</template>
<script setup>
import { ref, toRefs } from 'vue'
import SearchItemConfig from './schema-item-config'
const props = defineProps({
  /**
   * schema 配置结构
   {
    type: 'object',
    properties: {
      key: {
        ...schema, // 标准 schema 配置
        type: '', // 字段类型
        label: '', // 字段中文名 
        // search-bar 相关配置
        option: {
          ...eleComponentConfig, // 标准 el-component 配置
          comType:'', // 配置组件类型 
          default:'', // 默认值
          placeholder:'', // 占位符
        },
      },
   }
   */
  schema: {
    type: Object,
    default: () => ({})
  },
})

const { schema } = toRefs(props)

const emit = defineEmits(['load', 'search', 'reset'])

const searchComList = ref([])
// const handleSearchComList = (el) => {
//   searchComList.value.push(el)
// }

const getValue = () => {
  let dtoObj = {}
  searchComList.value.forEach(component => {
    dtoObj = { ...dtoObj, ...component?.getValue() }
  })
  return dtoObj
}

let childComLoadedCount = 0
const handleChildLoaded = () => {
  childComLoadedCount++
  if (childComLoadedCount >= Object.keys(schema?.value?.properties).length) {
    emit('load', getValue())
  }
}

const search = () => {
  emit('search', getValue())
}

const reset = () => {
  console.log('----', searchComList)
  searchComList.value.forEach(component => {
    component?.reset()
  })
  emit('reset')
}

defineExpose({
  search,
  reset,
  getValue
})

</script>
<style lang="less">
.schema-search-bar {
  min-width: 500px;
  .select{
    width: 200px;
  }
  .dynamic-select{
    width: 200px;
  }
  .search-btn {
    width: 100px;
  }
  .reset-btn {
    width: 100px;
  }
  .el-form-item {
    margin-bottom: 0;
  }
}
</style>