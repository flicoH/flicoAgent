<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-01 15:12:47
 * @LastEditors: flicoH
-->
<template>
  <iframe :src="path" class="iframe" frameborder="0"></iframe>
</template>
<script setup>
import { ref, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useMenuStore } from '$elpisStore/menu';

const route = useRoute()
const menuStore = useMenuStore()

const path = ref('')
const setPath = () => {
  const { key, sider_key: siderKey } =route.query
  const menuItem = menuStore.findMenuItem({
    key:'key',
    value: siderKey ?? key
  })
  path.value = menuItem?.iframeConfig?.path ?? ''
}
watch([
  () => route.query.key,
  () => route.query.soder_key,
  () => useMenuStore.menuList
], () => {
  setPath()
}, { deep: true })

onMounted(() => {
  setPath()
})
</script>

<style lang="less" scoped>
.iframe {
  border: 0;
  width: 100%;
  height: 100%;
}
</style>
