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
      <el-input-number
        v-model="dtoValue"
        v-bind="schema.option"
        :placeholder="placeholder"
        :controls="false"
        class="component-input"
        :class="validTips ? 'valid-border' : ''"
        @focus="onFocus"
        @blur="onBlur"
      ></el-input-number>
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
    type: Number,
    default: undefined
  }
})

const { schemaKey, schema } = props
const { model } = toRefs(props)

const name = ref('form-input-number')

const dtoValue = ref(undefined)
const validTips = ref(null)
const placeholder = ref('')

const initData = () => {
  dtoValue.value = model.value ?? schema.option?.default
  const {
    minimum,
    maximum,
  } = schema
  const ruleList = []

  if (schema.option?.placeholder) {
    ruleList.push(schema.option?.placeholder)
  }
  if (minimum != undefined) {
    ruleList.push(`最小值：${minimum}`)
  }
  if (maximum) {
    ruleList.push(`最大值：${maximum}`)
  }
  placeholder.value = ruleList.join('|')
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
    const validate = ajv.compile(schema)
    const valid = validate(dtoValue.value)
    if (!valid && validate.errors && validate.errors[0]) {
      const { keyword, params } = validate.errors[0]
      if (keyword === 'type') {
        validTips.value = `类型必须为${params.type}`
      } else if (keyword === 'minimum') {
        validTips.value = `最小值为${params.limit}`
      } else if (keyword === 'maxmum') {
        validTips.value = `最大值为${params.limit}`
      } else {
        console.log(validate.errors[0])
        validTips.value = `${keyword}校验失败`
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

const onFocus = () => {
  validTips.value = null
}
const onBlur = () => {
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