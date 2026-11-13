/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-01 11:39:23
 * @LastEditors: flicoH
 */
import { ref } from "vue"
import { defineStore } from "pinia";

export const useProjectStore = defineStore("project", () => {
  // 项目列表
  const projectList = ref([])
  // 设置项目列表
  const setProjectList = (list) => {
    projectList.value = list
  }
  return {
    projectList,
    setProjectList
  }
});