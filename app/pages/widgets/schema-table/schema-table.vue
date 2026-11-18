<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-03 11:01:48
 * @LastEditors: flicoH
-->
<template>
  <div class="schema-table">
    <el-table
      class="table"
      v-if="schema && schema.properties"
      v-loading="loading"
      :data="tableData"
    >
      <template v-for="(schemaItem, key) in schema.properties">
        <el-table-column
          v-if="schemaItem.option.visiable !== false"
          :key="key"
          :prop="key"
          :label="schemaItem.label"
          v-bind="schemaItem.option"
        ></el-table-column>
      </template>
      <el-table-column
        v-if="buttons?.length > 0"
        label="操作"
        fixed="right"
        :width="operationWidth"
      >
        <template #default="scope">
          <el-button
            v-for="(item, key) in buttons"
            :key="key"
            link
            v-bind="item"
            @click="operationHanler({ btnConfig: item, rowData: scope.row })"
            >{{ item.label }}</el-button
          >
        </template>
      </el-table-column>
    </el-table>
    <el-row justify="end" class="pagination">
      <el-pagination
        :current-page="currentPage"
        :page-size="pageSize"
        :page-sizes="[10, 20, 30, 40]"
        :total="total"
        layout="total,sizes,prev.pager,next,jumper"
        @size-change="onPageSizeChange"
        @current-change="onCurrentChange"
      ></el-pagination>
    </el-row>
  </div>
</template>
<script setup>
import {
  ref,
  toRefs,
  computed,
  watch,
  nextTick,
  onMounted
} from 'vue';
import $curl from '$elpisCommon/curl'
const props = defineProps({
  /**
   * schema配置
    { 
      type: 'object',
      proprties: {
        key: {
          ...scheam, // 标准scheam配置
          type: '', // 字段类型
          label: '', // 字段中文名 
          // 字段table中的相关配置
          option: {
            ...elTableColumnConfig, // 标准的el-table-column配置
            visiable: true, // 默认true (false || 不配置，不在表中显示)
          },
        },
      }
    }
   */
  schema: Object,
  /**
   * 表格数据源 api
   */
  api: String,
  /**
   * api 请求参数携带参数
   */
  apiParmas:Object,
  /**
   * 操作按钮 相关配置
    [{
      label: '', // 按钮中文
      eventKey: 'add',// 按钮事件名
      eventOptions: {},// 按钮事件具体配置
      ...elButtonConfig, // 标准 el-button 配置
    }]
   */
  buttons: Array
})

const emit = defineEmits(['operate'])

const { schema, api, apiParmas, buttons } = toRefs(props)

const operationWidth = computed(() => {
  return buttons?.value.length > 0 ? buttons.value.reduce((pre, cur) => {
    return pre + cur.label.length * 18
  }, 50) : 50
})

const loading = ref(false)
const tableData = ref([])
const currentPage = ref(1) 
const pageSize = ref(50)
const total = ref(0)

onMounted(() => {
  initData()
})

watch([schema, api,apiParmas], () => {
  initData()
}, { deep: true })

const initData = () => {
  currentPage.value = 1
  pageSize.value = 50
  nextTick(async () => {
    await loadTableData()
  })
}

let timerId = null
const loadTableData = async () => {
  clearTimeout(timerId)
  timerId = setTimeout(async () => {
    await fetchTableData()
    timerId = null
  }, 300)
}


const fetchTableData = async () => {
  if (!api.value) { return }

  showLoading()

  // 请求列表接口
  const res = await $curl({
    method: 'GET',
    url: `${api.value}/list`,
    query: {
      ...apiParmas.value,
      page: currentPage.value,
      size: pageSize.value
    }
  })

  hideLoading()

  if (!res || !res.success || !Array.isArray(res.data)) {
    tableData.value = []
    total.value = 0
  }

  tableData.value = buildTabelData(res.data || [])
  total.value = res.metaData?.total || 0
}


/**
 * 对返回数据镜像渲染预处理
 * @param {Array} listData 
 * @returns {}
 */
const buildTabelData = (listData) => {
  if (!schema.value?.properties) {
    return listData
  }
  return listData.map(dataItem => {
    for (const key in dataItem) {
      const schemaItem = schema.value.properties[key]
      // 处理toFixed
      if (schemaItem?.option?.toFixed) {
        dataItem[key] = dataItem[key].toFixed && dataItem[key].toFixed(schemaItem.option.toFixed)
      }
      return dataItem
    }
  })
}

const showLoading = () => {
  loading.value = true
}
const hideLoading = () => {
  loading.value = false
}

const operationHanler = ({ btnConfig, rowData }) => {
  emit('operate', { btnConfig, rowData })
}

const onPageSizeChange = async (value) => {
  pageSize.value = value
  await loadTableData()
}
const onCurrentChange = async (value) => {
  currentPage.value = value
  await loadTableData()
}

defineExpose({
  initData,
  showLoading,
  hideLoading,
  loadTableData
})

</script>

<style lang="less" scoped>
.schema-table {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: auto;
  .table {
    flex: 1;
  }
  .pagination {
    margin: 10px 0;
    text-align: right;
  }
}
</style>
