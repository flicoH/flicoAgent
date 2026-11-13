/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2026 huangqinjia(flicoH)。 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-05-10 15:51:32
 * @LastEditors: flicoH
 * @LastEditTime: 2026-09-04 16:31:38
 */

import { createApp } from "vue";
  
// 引入UI
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css'
import '$agentAssets/cusiom.css'

// 引入pinia
import pinia from '$agentStore'
// 引入路由
import { createRouter, createWebHistory } from 'vue-router'


/** 
 * 页面初始化，vue页面主入口
 * @param pageComponent vue入口组件
 * @param routes 路由配置
 * @param libs 页面第三方库配置
*/
export default (pageComponent, { routes, libs } = {}) => {
  const app = createApp(pageComponent)
  // 应用UI
  app.use(ElementPlus);
  // 引入pinia
  app.use(pinia)

  // 引用第三方包 
  if(libs && libs.length){
    for(let i = 0; i < libs.length; i++){
      app.use(libs[i])
    }
  }

  // 创建页面路由
  if (routes && routes.length) {
    const router = createRouter({
      history: createWebHistory(), // 采用history模式
      routes,
    })
    app.use(router)
    router.isReady().then(() => {
      app.mount('#root')
    })
  } else {
    app.mount('#root')
  }

}

