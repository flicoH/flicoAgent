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
  <el-select class="dynamic-select" v-model="dtoValue" v-bind="schema.option">
    <el-option
      v-for="item in enumList"
      :key="item.value"
      :label="item.label"
      :value="item.value"
    ></el-option>
  </el-select>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import $curl from '$agentCommon/curl'
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

const enumList = ref([])
const fetchEnumList = async () => {
  const res = await $curl({
    method: 'get',
    url:schema.option?.api,
    data: {}
  })
  if (res?.data?.length > 0) {
    enumList.value.push(...res?.data)
  }
}

const reset = () => {
  dtoValue.value = schema?.option?.default ?? enumList.value[0]?.value
}
onMounted(async () => {
  await fetchEnumList()
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