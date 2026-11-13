<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-07 17:03:56
 * @LastEditors: flicoH
-->
<template>
  <el-select class="select" v-model="dtoValue" v-bind="schema.option">
    <el-option
      v-for="item in schema.option?.enumList"
      :key="item.value"
      :label="item.label"
      :value="item.value"
    ></el-option>
  </el-select>
</template>
<script setup>
import { ref, onMounted } from 'vue'
const { schemaKey, schema } = defineProps({
  schemaKey: {
    type: String,
    default: ''
  },
  schema: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['loaded'])

const dtoValue = ref()
const getValue = () => {
  return dtoValue.value !== undefined ? { [schemaKey]: dtoValue.value } : {}
}
const reset = () => {
  dtoValue.value = schema?.option?.default ?? schema.option?.enumList[0]?.value
}

onMounted(()=>{
  reset()
  emit('loaded')
})

defineExpose({
  getValue,
  reset
})
</script>
<style lang="less" scoped>
</style>