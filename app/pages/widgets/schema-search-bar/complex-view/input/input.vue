<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-07 11:39:38
 * @LastEditors: flicoH
-->
<template>
  <el-input v-model="dtoValue" v-bind="schema.option" class="input"></el-input>
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
  dtoValue.value = schema?.option?.default
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