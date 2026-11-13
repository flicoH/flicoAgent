<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-02 17:37:43
 * @LastEditors: flicoH
-->
<template>
  <el-card class="table-panel">
    <!-- operation-panel -->
    <el-row
      v-if="tableConfig?.headerButtons?.length > 0"
      justify="end"
      class="operation-panel"
    >
      <el-button
        v-for="(item, key) in tableConfig?.headerButtons"
        :key="key"
        v-bind="item"
        @click="operationHandler({ btnConfig: item })"
      >{{ item.label }}</el-button>
    </el-row>
    <!-- schema-table(组件 widget) -->
    <schema-table
      ref="schemaTableRef"
      :schema="tableSchema"
      :api="api"
      :apiParmas="apiParmas"
      :buttons="tableConfig?.rowButtons ?? []"
      @operate="operationHandler"
    >
    </schema-table>
  </el-card>
</template>
<script setup>
import { ref, inject } from 'vue'
import { ElMessageBox, ElNotification } from 'element-plus';
import $curl from '$agentCommon/curl.js'
import schemaTable from '$agentSchemaTable';

const emit = defineEmits(['operate'])

const {
  api,
  apiParmas,
  tableSchema,
  tableConfig,
} = inject('schemaViewData')

const schemaTableRef = ref(null)

const EventHandlerMap = {
  remove: removeData
}
const operationHandler = ({ btnConfig, rowData }) => {
  const { eventKey } = btnConfig
  const eventHandler = EventHandlerMap[eventKey]

  if (eventHandler) {
    eventHandler({ btnConfig, rowData })
  } else {
    emit('operate', { btnConfig, rowData })
  }
}
function removeData({ btnConfig, rowData }) {
  const { eventOption } = btnConfig
  if (!eventOption?.params) { return }
  const { params } = eventOption

  const removeKey = Object.keys(params)[0]
  let removeValue = params[removeKey]
  const removeValueList = `${removeValue}`.split('::')
  if (removeValueList[0] === 'schema' && removeValueList[1]) {
    removeValue = rowData[removeValueList[1]]
  }

  ElMessageBox.confirm(`确定删除 ${removeKey}为：${removeValue}数据？`,
    'Warning',
    {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(async () => {
    schemaTableRef.value.showLoading()
    const res = await $curl({
      method: 'delete',
      url: api.value,
      data: {
        [removeKey]: removeValue
      },
      errorMessage: '删除失败'
    })
    schemaTableRef.value.hideLoading()
    if (!res || !res.success || !res.data) {
      return
    }
    ElNotification({
      title: '删除成功',
      message: '删除成功',
      type: 'success'
    })
    await initTableData()
  })
}

const initTableData = async () => {
  await schemaTableRef.value.initData()
}

const loadTableData = async () => {
  await schemaTableRef.value.loadTableData()
}

defineExpose({
  loadTableData
})


</script>
<style lang="less" scoped>
.table-panel {
  flex: 1;
  margin: 10px;
  .operation-panel {
    margin-bottom: 10px;
  }
}
:deep(.el-card__body) {
  height: 98%;
  display: flex;
  flex-direction: column;
}
</style>
