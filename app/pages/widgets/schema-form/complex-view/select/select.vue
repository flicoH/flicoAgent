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
  <el-row type="flex" align="middl" class="form-item">
    <!-- label -->
    <el-row class="item-label" justify="end">
      <el-row v-if="schema.option?.required" type="flex" class="required"
        >*</el-row
      >
      {{ schema.label }}
    </el-row>
    <!-- value -->
    <el-row class="item-value" justify="end">
      <el-select
        class="component-select"
        :class="validTips ? 'valid-border' : ''"
        v-model="dtoValue"
        v-bind="schema.option"
        @onChange="onChange"
      >
        <el-option
          v-for="item in schema.option?.enumList"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        ></el-option>
      </el-select>
    </el-row>
    <!-- 错误信息 -->
    <el-row v-if="validTips" class="valid-tips">
      {{ validTips }}
    </el-row>
  </el-row>
</template>
<script setup>
import { ref, toRefs, watch, inject, onMounted } from 'vue'
const ajv = inject('ajv')

const props = defineProps({
  schemaKey: {
    type: String,
    default: ''
  },
  schema: {
    type: Object,
    default: () => ({})
  },
  model: {
    type: Object,
    default: undefined
  }
})

const { schemaKey, schema } = props
const { model } = toRefs(props)

const name = ref('form-select')

const dtoValue = ref(undefined)
const validTips = ref(null)

const initData = () => {
  dtoValue.value = model.value ?? schema.option?.default
  validTips.value = null

}

watch([model, schema], () => {
  initData()
}, { deep: true })

const validate = () => {
  validTips.value = null
  
  // 检验必填
  if (schema.option?.required && !dtoValue.value) {
    validTips.value = '不能为空'
    return false
  }
  if (dtoValue.value) {
    let dtoEnum = []
    if (schema.option?.enumList) {
      dtoEnum = schema.option?.enumList.map(item => item.value)
    }
    const validate = ajv.compile({
      schema,
      ...{ enum: dtoEnum }
    })

    const valid = validate(dtoValue.value)

    if(!valid && validate.errors && validate.errors[0]){
      if(validate.errors[0].keyword === 'enum'){
        validTips.value = '取值没在枚举范围'
      }else{
        console.log(validate.errors[0])
        validTips.value = `校验失败`
      }
      return false
    }
  }
  return true
}

const getValue = () => {
  return dtoValue.value !== undefined ? {
    [schemaKey]: dtoValue.value
  } : {}
}

const onChange = () => {
  validate()
}

onMounted(() => {
  initData()
})

defineExpose({
  name,
  validate,
  getValue
})
</script>
<style lang="less" scoped>
:deep(.el-input-number .el-input__inner) {
  text-align: left;
}
</style>