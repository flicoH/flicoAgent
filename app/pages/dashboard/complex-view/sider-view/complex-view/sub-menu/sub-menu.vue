<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-02 15:45:14
 * @LastEditors: flicoH
-->
<template>
  <el-sub-menu :index="menuItem.key">
  <template #title>
    {{ menuItem.name }}
  </template>
  <div v-for="item in menuItem.subMenu" :key="item.key">
    <sub-menu v-if="item.subMenu && item.subMenu.length > 0" :menu-item="item">
    </sub-menu>
    <el-menu-item v-else :index="item.key">
      {{ item.name }}
    </el-menu-item>
  </div>
</el-sub-menu>
</template>
<script setup>
const { menuItem } = defineProps([
  'menuItem'
])
</script>
<style lang="less" scoped>
</style>