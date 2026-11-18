<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-02 17:37:53
 * @LastEditors: flicoH
-->
<template>
  <el-card class="search-panel">
    <schema-search-bar
     :schema="searchSchema"
     @load="onLoad"
     @search="onSearch"
     @reset="onReset"
    ></schema-search-bar>
  </el-card>
</template>
<script setup>
import { inject } from 'vue'
import SchemaSearchBar from '$elpisSchemaSearchBar'
const { searchSchema } = inject('schemaViewData')

const emit = defineEmits(['search']);

const onLoad = (searchValObj) => {
  emit('search', searchValObj)
}

const onSearch = (searchValObj) => {
  emit('search', searchValObj)
}

const onReset = () => {
  emit('search', {})
}
</script>
<style lang="less" scoped>
.search-panel {
  margin: 10px 10px 0 10px;
}
:deep(.el-card__body) {
  padding-bottom: 2px;
}
</style>