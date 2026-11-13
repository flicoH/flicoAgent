<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-09 11:36:54
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
      <schema-form
        ref="schemaFormRef"
        :loading="loading"
        :schema="components[name]?.schema"
      ></schema-form>
    </template>
    <template #footer>
      <el-button type="primary" @click="save">{{ saveBtnText }}</el-button>
    </template>
  </el-drawer>
</template>
<script setup>
import { ref, inject } from 'vue'
import { ElNotification } from 'element-plus'
import SchemaForm from '$agentSchemaForm'
import $curl from '$agentCommon/curl.js'
const {
  api,
  components,
} = inject('schemaViewData')

const emit = defineEmits(['command'])

const name = ref('createForm')
const loading = ref(false)

const schemaFormRef = ref(null)
const isShow = ref(false)
const title = ref('')
const saveBtnText = ref('')

const close = () => {
  isShow.value = false
}

const show = (rowData) => {
  const { config } = components.value[name.value]
  title.value = config.title
  saveBtnText.value = config.saveBtnText

  isShow.value = true
}

const save = async () => {
  if (loading.value) { return }

  if (!schemaFormRef.value.validate()) { return }
  loading.value = true

  const res = await $curl({
    method: 'post',
    url: api.value,
    data: {
      ...schemaFormRef.value.getValue()
    }
  })
  loading.value = false
  if (!res || !res.success) {
    return
  }
  ElNotification({
    title: '创建成功',
    message: '创建成功',
    type: 'success'
  })
  close()

  emit('command', {
    event: 'loadTableData'
  });
}

defineExpose({
  name,
  show,
})

</script>
<style lang="less" scoped>
</style>