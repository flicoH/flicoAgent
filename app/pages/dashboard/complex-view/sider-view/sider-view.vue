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
  <sider-container>
    <template #menu-content>
      <el-menu
        :default-active="activeKey"
        :ellipsis="false"
        mode="vertical"
        @select="onMenuSelect"
      >
        <template v-for="item in menuList">
          <sub-menu
            v-if="item.subMenu && item.subMenu.length > 0"
            :menu-item="item"
          ></sub-menu>
          <el-menu-item v-else :index="item.key">
            {{ item.name }}
          </el-menu-item>
        </template>
      </el-menu>
    </template>
    <template #main-content>
      <slot name="main-content">
        <router-view></router-view>
      </slot>
    </template>
  </sider-container>
</template>
<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useMenuStore } from '$elpisStore/menu.js';
import SiderContainer from '$elpisSiderContainer'
import SubMenu from './complex-view/sub-menu/sub-menu.vue'

const router = useRouter()
const route = useRoute()
const menuStore = useMenuStore()

const menuList = ref([])
const setMenuList = () => {
  const menuItem = menuStore.findMenuItem({
    key: 'key',
    value: route.query.key
  })
  console.log('menuItem', menuItem)
  if (menuItem && menuItem.siderConfig && menuItem.siderConfig.menu) {
    menuList.value = menuItem.siderConfig.menu
  }
}


const activeKey = ref('')
const setActiveKey = () => {
  let siderMenuItem = menuStore.findMenuItem({
    key: 'key',
    value: route.query.sider_key
  })
  // 如果首次加载未寻找菜单，默认选择第一个
  if (!siderMenuItem) {
    const headerMenuItem = menuStore.findMenuItem({
      key: 'key',
      value: route.query.key
    })
    if (headerMenuItem && headerMenuItem.siderConfig && headerMenuItem.siderConfig.menu) {
      const siderMenuList = headerMenuItem.siderConfig.menu
      siderMenuItem = menuStore.findFirstMenuItem(siderMenuList) // 找出左侧菜单第一项
      if (siderMenuItem) {
        handleMenuSelect(siderMenuItem.key) // 触发菜单选择事件，跳转到对应路由
      }
    }
  }
  activeKey.value = siderMenuItem?.key
}

watch(() => { route.query.key }, () => {
  setActiveKey()
})
watch(() => { menuStore.menuList }, () => {
  setMenuList()
  setActiveKey()
}, { deep: true })

const onMenuSelect = (menuKey) => {
  handleMenuSelect(menuKey)
}

const handleMenuSelect = (menuKey) => {
  const siderMenuItem = menuStore.findMenuItem({
    key: 'key',
    value: menuKey
  })
  const { moduleType, key, customConfig } = siderMenuItem

  // 当前页不处理
  if (key === route.query.sider_key) {
    return
  }

  const pathMap = {
    iframe: '/iframe',
    schema: '/schema',
    custom: customConfig?.path,
  }

  router.push({
    path: `/view/dashboard/sider${pathMap[moduleType]}`,
    query: {
      key: route.query.key,
      proj_key: route.query.proj_key,
      sider_key: menuKey
    }
  })
} 

onMounted(() => {
  setMenuList()
  setActiveKey()
})

</script>

<style lang="less" scoped>
</style>
