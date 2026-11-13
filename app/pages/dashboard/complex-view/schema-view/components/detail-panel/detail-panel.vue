<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-11 13:47:06
 * @LastEditors: flicoH
-->
<template>
  <el-drawer
    v-model="isShow"
    direction="rtl"
    :destroy-on-close="true"
    :size="550"
  >
    <template #header>
      <h3>{{ title }}</h3>
    </template>
    <template #default>
      <el-card :loading="loading" shadow="always" class="detail-panel-card">
        <el-row
          v-for="(item,key) in components[name]?.schema?.properties"
          :key="key"
          type="flex"
          align="middle"
          class="row-item"
        >
          <el-row class="item-label">{{ item.label }}:</el-row>
          <el-row class="item-value">{{ dtoModel[key] }}</el-row>
        </el-row>
      </el-card>
    </template>
    <template #footer>
      <el-button type="primary" @click="save">{{ saveBtnText }}</el-button>
    </template>
  </el-drawer>
</template>
<script setup>
import { ref, inject } from 'vue'
import $curl from '$agentCommon/curl.js'
const {
  api,
  components,
} = inject('schemaViewData')


const name = ref('detailPanel')
const loading = ref(false)

const isShow = ref(false)
const title = ref('')
const saveBtnText = ref('')
const mainKey = ref('')
const mainValue = ref({})
const dtoModel = ref({})

const close = () => {
  isShow.value = false
}

const show = (rowData) => {
  const { config } = components.value[name.value]
  title.value = config.title
  saveBtnText.value = config.saveBtnText
  
  mainKey.value = config.mainKey // 表单组件
  mainValue.value = rowData[config.mainKey]
  dtoModel.value = {}

  isShow.value = true

  fetchFromData()
}

const fetchFromData = async () => {
  if (loading.value) { return }
  const res = await $curl({
    method: 'get',
    url: api.value,
    query: {
      [mainKey.value]: mainValue.value
    }
  })

  if (!res || !res.success || !res.data) { return }

  dtoModel.value = res.data
}

const save = async () => {
  close()
}

defineExpose({
  name,
  show,
})

</script>
<style lang="less" scoped>
.detail-panel-card{
  border: 1px solid #a6a6a6;
  padding: 20px;
  .row-item{
    height:40px;
    line-height: 40px;
    font-size: 20px;
    .item-label{
      margin-right:20px;
      width:120px;
      color: #fff;
    }
    .item-value{
      
    }
  }
}
</style>