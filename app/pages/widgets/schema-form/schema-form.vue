<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-09 17:02:07
 * @LastEditors: flicoH
-->
<template>
  <el-row v-if="schema && schema.properties" class="shema-form">
    <template v-for="(itemSchema, key) in schema.properties">
      <component
        ref="formComList"
        :is="FormItemConfig[itemSchema.option?.comType].component"
        :schemaKey="key"
        :schema="itemSchema"
        :model="model ? model[key] : undefined"
      ></component>
    </template>
  </el-row>
</template> 
<script setup>
import { ref, toRefs, provide } from 'vue'
import Ajv from 'ajv'
import FormItemConfig from './form-item-config'

const ajv = new Ajv()
provide('ajv', ajv)
const props = defineProps({
  /**
   * schema 配置结构
    {
      key: {
        ...schema, // 标准 schema 配置
        type: '', // 字段类型
        label: '', // 字段中文名 
        Option: {
          ...eleComponentConfig,
          comType:'', // 控件类型
          required: false, // 表单必填项，默认false
          visible:true, // 是否展示 默认为true
          disabled:false, // 是否禁用 默认false
          default: '', // 默认值
          
          // comType === 'select'
          enumList:[], // 枚举列表
        },
      },
    }
   */
  schema: Object,
  /**
   * 表单数据
   */
  model: Object,
})
const { schema, model } = toRefs(props)

const formComList = ref([])

// 表单校验
const validate = () => {
  console.log()
  return formComList.value.every(item => item.validate())
}
// 获取表单值
const getValue = () => {
  return formComList.value.reduce((dtoObj, component) => {
    return {
      ...dtoObj,
      ...component.getValue()
    }
  }, {})
}

defineExpose({
  validate,
  getValue
})


</script>
<style lang="less">
.shema-form {
  .form-item {
    margin-bottom: 20px;
    min-width: 500px;
    .item-label {
      margin-right: 15px;
      min-width:70px;
      text-align: right;
      font-size:14px;
      color:#fff;
      word-break:break-all;
      .required {
        top:2px;
        padding-left:4px;
        color: #f56c6c;
        font-size: 20px;
      }
    }
    .item-value {
      .component-input,
      .component-select {
        width: 320px;
      }
      .valid-border{
        .el-input__wrapper,
        .el-select__wrapper{
          border: 1px solid red;
        }
      }
    }
    .valid-tips {
      margin-left: 10px;
      height:36px;
      overflow:hidden;
      font-size:12px;
      color:red
    }
  }
}
</style>
