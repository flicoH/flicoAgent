<!--
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-02 15:20:20
 * @LastEditors: flicoH
-->
<template>
  <el-container class="sider-container">
    <el-aside width="200px" class="aside">
      <slot name="menu-content"></slot>
    </el-aside>
    <el-main class="main">
      <slot name="main-content"></slot>
    </el-main>
  </el-container>
</template>
<script setup>

</script>
<style lang="less" scoped>
.sider-container {
  height: 100%;
  .aside {
    border-right: 1px solid #e8e8e8;
  }
  .main {
    overflow: scroll;
  }
}
:deep(.el-menu) {
  border-right: 0;
}
</style>