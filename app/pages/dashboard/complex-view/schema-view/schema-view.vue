<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-01 15:12:47
 * @LastEditors: flicoH
-->
<template>
  <el-row class="schema-view">
    <search-panel
      v-if="
        searchSchema?.properties &&
        Object.keys(searchSchema?.properties).length > 0
      "
      @search="onSearch"
    ></search-panel>
    <table-panel ref="tablePanelRef" @operate="onTableOperate"></table-panel>
    <!-- 渲染动态组件 -->
    <component
      v-for="(item, key) in components"
      :key="key"
      :schema="item.schema"
      :option="item.config"
      ref="comListRef"
      :is="ComponentConfig[key]?.component"
      @command="onComponentCommand"
    ></component>
  </el-row>
</template>
<script setup>
import { ref, provide } from 'vue'
import SearchPanel from './complex-view/search-panel/search-panel.vue'
import TablePanel from './complex-view/table-panel/table-panel.vue'
import ComponentConfig from './components/component-config.js'
import { useSchema } from './hook/schema.js'

const {
  api,
  tableConfig,
  tableSchema,
  searchSchema,
  searchConfig,
  components
} = useSchema()

console.log(components)


const apiParmas = ref({})
provide('schemaViewData', {
  api,
  apiParmas,
  tableConfig,
  tableSchema,
  searchSchema,
  searchConfig,
  components
})

const tablePanelRef = ref([])
const comListRef = ref([])

const onSearch = (searchValObj) => {
  apiParmas.value = searchValObj
}

// table事件映射
const EventHandlerMap = {
  showComponent: showComponent
}
const onTableOperate = ({ btnConfig, rowData }) => {
  const { eventKey } = btnConfig

  if (EventHandlerMap[eventKey]) {
    EventHandlerMap[eventKey]({ btnConfig, rowData })
  }
}
function showComponent({ btnConfig, rowData }) {

  const { comName } = btnConfig.eventOption
  if (!comName) { return }
  
  const comRef = comListRef.value.find(item => item.name === comName)
  console.log(comRef)
  if (!comRef || typeof comRef.show !== 'function') { return }

  comRef.show(rowData)
}


const onComponentCommand = (data) => {
  const { event } = data
  if (event === 'loadTableData') {
    tablePanelRef.value.loadTableData()
  }
}

</script>

<style lang="less" scoped>
.schema-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}
</style>
