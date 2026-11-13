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
  <header-container :title="projName">
    <template #menu-container>
      <el-menu
        :default-active="activeKey"
        :ellipsis="false"
        mode="horizontal"
        @select="onMenuSelect"
      >
        <template 
          v-for="item in menuStore.menuList" 
        >
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
    <template #setting-container>
      <!-- 根据projectStore中的配置，展示对应的projectList -->
      <el-dropdown @command="handlProjectCommand">
        <span
          >{{ projName }}
          <el-icon
            v-if="projectStore.projectList.length > 1"
            class="el-icon--right"
          >
            <ArrowDown />
          </el-icon>
        </span>
        <template v-if="projectStore.projectList.length > 1" #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="item in projectStore.projectList"
              :key="item.key"
              :command="item.key"
              :disabled="item.name === projName"
            >
              {{ item.name }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>
    <template #main-content>
      <slot name="main-content"></slot>
    </template>
  </header-container>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowDown } from '@element-plus/icons-vue'
import HeaderContainer from '$agentHeaderContainer'
import SubMenu from './complex-view/sub-menu/sub-menu.vue'
import { useMenuStore } from '$agentStore/menu.js';
import { useProjectStore } from '$agentStore/project.js';

const route = useRoute()
const menuStore = useMenuStore()
const projectStore = useProjectStore()


defineProps({
  projName: {
    type: String,
    default: ''
  }
})
const emit = defineEmits(['menu-select'])

const activeKey = ref('')
const setActiveKey = () => {
  const menuItem = menuStore.findMenuItem({
    key: 'key',
    value: route.query.key
  })
  activeKey.value = menuItem?.key
}
watch(() => { route.query.key }, () => {
  setActiveKey()
})
watch(() => { menuStore.menuList }, () => {
  setActiveKey()
}, { deep: true })
onMounted(() => {
  setActiveKey()
})



const onMenuSelect = (menuKey) => {
  const menuItem = menuStore.findMenuItem({
    key: 'key',
    value: menuKey
  })
  emit('menu-select', menuItem)
}

const handlProjectCommand = (event) => {
  // 根据command处理项目切换逻辑  
  const projectItem = projectStore.projectList.find(item => item.key === event)
  if (!projectItem && !projectItem.homePage) {
    return
  }
  const { host, pathname } = window.location
  window.location.replace(`${host}${pathname}/${projectItem.homePage}`)
  window.location.reload() // 刷新页面以应用新的项目配置
}

</script>

<style lang="less" scoped>
.project-list {
  margin-right: 20px;
  cursor: pointer;
  color: ver(--el-color-primary);
  display: flex;
  align-items: center;
  outline: none;
}
:deep(.el-menu--horizontal.el-menu) {
  border-bottom: 0;
}
</style>