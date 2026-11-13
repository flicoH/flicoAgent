<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-08 10:12:53
 * @LastEditors: flicoH
-->
<template>
  <el-date-picker
    clas="date-range"
    v-model="dtoValue"
    v-bind="schema.option"
    type="daterange"
    range-separator="~"
    :start-placeholder="schema.label + '开始'"
    :end-placeholder="schema.label + '结束'"
  >
  </el-date-picker>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import monent from 'moment'

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
  return dtoValue.value.length === 2 ? 
  { 
    [`${schemaKey}_start`]: monent(dtoValue.value[0]).format('YYYY-MM-DD'), 
    [`${schemaKey}_end`]: monent(dtoValue.value[1]).format('YYYY-MM-DD') 
  } : {}
}
const reset = () => {
  dtoValue.value = schema?.option?.default??[]
}

onMounted(() => {
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