<!--
 * @Author: flicoH huangqinjia
 * @Date: 2026-08-28 13:37:17
 * @LastEditors: flicoH
 * @LastEditTime: 2026-09-01 16:54:59
 * @FilePath: /flicoH-elips/app/pages/widgets/header-container/asserts/header-container.vue
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
-->
<template>
  <el-container class="header-container">
    <el-header class="header">
      <el-row type="flex" align="middle" class="header-row">
        <!-- 左上方 -->
        <el-row type="flex" align="middle" class="title-panel">
          <img src="./asserts/logo.png" class="logo" />
          <el-row class="text">{{ title }}</el-row>
        </el-row>
        <!-- menu -->
        <slot name="menu-container"></slot>
        <!-- 右上方 -->
        <el-row type="flex" align="middle" justify="end" class="setting-panel">
          <!-- 设置区域 -->
          <slot name="setting-container"></slot>
          <img src="./asserts/user.png" alt="" class="avatar">
          <el-dropdown @command="handleUser">
            <span class="user-name">{{ userName }} <i class="el-icon-arrow-down el-icon--right"></i></span>
            <template #dropdown>
              <el-dropdown-item command="logout">退出登录</el-dropdown-item>
            </template>
          </el-dropdown>
        </el-row>
      </el-row>
    </el-header>
    <el-main class="main-container">
      <!-- 外部拓展核心区域 -->
      <slot name="main-content"></slot>
    </el-main>
  </el-container>
</template>
<script setup>
import { ref } from 'vue'

defineProps({
  title: String
})

const userName = ref('flicoH')
const handleUser = (event) => {

}

</script>
<style lang="less" scoped>
  .header-container {
    height: 100%;
    min-width: 1000px;
    overflow: hidden;
    .header {
      max-height: 120px;
      border-bottom: 1px solid;
      .header-row {
        height: 60px;
        padding: 0 20px;
        .title-panel {
          width: 180px;
          min-width: 180px;
          .logo {
            margin-right: 10px;
            width: 25px;
            height: 25px;
            border-radius: 10px;
            margin-right: 10px;
          }
          .text {
            font-size: 15px;
          }
        }
        .setting-panel{
          margin-left:auto;
          min-width: 180px;

          .avatar{
            width: 25px;
            height: 25px;
            border-radius: 10px;
            margin-right: 10px;
          }
          .user-name{
            font-size: 15px;
            cursor: pointer;
          }
        }
      }
    }
    .main-container {
    }
  }
  :deep(.el-header) {
    padding: 0;
  }
</style>