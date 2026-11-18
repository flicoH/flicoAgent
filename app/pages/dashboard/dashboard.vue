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
  <el-config-provider :lang="zhCn">
    <header-view :proj-name="projcetName" @menu-select="onMenuSelect">
      <template #main-content>
        <!-- 主要内容区域 -->
        <router-view></router-view>
      </template>
    </header-view>
  </el-config-provider>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import HeaderView from './complex-view/header-view/header-view.vue'
import $curl from '$elpisCommon/curl.js'
import { useMenuStore } from '$elpisStore/menu.js';
import { useProjectStore } from '$elpisStore/project.js';

const router = useRouter()
const route = useRoute()
const menuStore = useMenuStore()
const projectStore = useProjectStore()

const projcetName = ref('')

// 请求projceList
async function getProjcetList() {
  const res = await $curl({
    method: 'get',
    url: '/api/project/list',
    query: {
      // todo 动态获取当前项目key
      proj_key: route.query.proj_key
    },
    errorMessages: '获取项目列表失败'
  });
  if (!res || !res.success || !res.data) {
    return
  }
  projectStore.setProjectList(res.data)
}

// 请求project
async function getProjectConfig() {
  const res = await $curl({
    method: 'get',
    url: '/api/project',
    query: {
      // todo 动态获取当前项目key
      proj_key: route.query.proj_key
    },
    errorMessages: '获取项目配置失败'
  });
  if (!res || !res.success || !res.data) {
    return
  }
  const { name, menu } = res.data
  projcetName.value = name
  menuStore.setMenuList(menu)
}

// 点击菜单回调
const onMenuSelect = (menuItem) => {
  const { moduleType, key, customConfig } = menuItem
  // 当前不处理
  if (key === route.query.key) {
    return
  }
  const pathMap = {
    sider: '/sider',
    iframe: '/iframe',
    schema: '/schema',
    custom: customConfig?.path,
  }

  router.push({
    path: `/view/dashboard${pathMap[moduleType]}`,
    query: {
      key: key,
      proj_key: route.query.proj_key 
    }
  })
}

// 初始化
onMounted(() => {
  getProjcetList()
  getProjectConfig()
})  
</script>

<style lang="less" scoped>
</style>