<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-01 11:13:17
 * @LastEditors: flicoH
-->
<template>
  <el-sub-menu :index="menuItem.key">
    <template #title>
    {{ menuItem.name }}
    </template>
    <template v-for="item in menuItem.subMenu">
      <sub-menu
        v-if="item.subMenu && item.subMenu.length > 0"
        :menu-item="item"
      >
      </sub-menu>
      <el-menu-item v-else :index="item.key">
        {{ item.name }}
      </el-menu-item>
    </template>
  </el-sub-menu>
</template>
<script setup>
const { menuItem } = defineProps([
  'menuItem'
])

</script>

<style lang="less" scoped>
</style>