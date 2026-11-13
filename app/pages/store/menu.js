/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-01 11:35:07
 * @LastEditors: flicoH
 */
import { ref } from "vue"
import { defineStore } from "pinia";

export const useMenuStore = defineStore("menu", () => {
  // 菜单列表
  const menuList = ref([])
  // 设置菜单列表
  const setMenuList = (list) => {
    menuList.value = list
  }

  /** 
   * 找出菜单目录
   * @param key 搜索字段
   * @param value 搜索值
   * @param mList 菜单列表
   * @returns 菜单项
   */
  const findMenuItem = ({ key, value }, mList = menuList.value) => {
    for (let i = 0; i < mList.length; i++) {
      const menuItem = mList[i]
      if (!menuItem) { continue }
      const { menuType, moduleType } = menuItem
      if (menuItem[key] === value) {
        return menuItem
      }

      if (menuType === 'group' && menuItem.subMenu) {
        const subMenuItem = findMenuItem({ key, value }, menuItem.subMenu)
        if (subMenuItem) {
          return subMenuItem
        }
      }

      if (moduleType === 'sider' && menuItem.siderConfig?.menu) {
        const subMenuItem = findMenuItem({ key, value }, menuItem.siderConfig.menu)
        if (subMenuItem) {
          return subMenuItem
        }
      }
    }
  }
  // 找出第一个菜单
  const findFirstMenuItem = (mList = menuList.value) => {
    if (!mList || mList.length === 0) { return }
    let firstMenuItem = mList[0]
    if (firstMenuItem.subMenu && firstMenuItem.subMenu.length > 0) {
      firstMenuItem = findFirstMenuItem(firstMenuItem.subMenu)
    }
    return firstMenuItem
  }

  return {
    menuList,
    setMenuList,
    findMenuItem,
    findFirstMenuItem
  }
});