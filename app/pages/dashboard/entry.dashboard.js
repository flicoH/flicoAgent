/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-08-28 13:48:36
 * @LastEditors: flicoH
 */
import boot from '$agentPages/boot'
import dashboard from './dashboard.vue'
import businessDashBoardRouterConfig from '$businessDashBoardRouterConfig'



const routes = []
// 头部菜单
routes.push({
  path: '/view/dashboard/iframe',
  component: () => import('./complex-view/iframe-view/iframe-view.vue')
})
routes.push({
  path: '/view/dashboard/schema',
  component: () => import('./complex-view/schema-view/schema-view.vue')
})

const siderRoutes = [
  {
    path: 'iframe',
    component: () => import('./complex-view/iframe-view/iframe-view.vue')
  },
  {
    path: 'schema',
    component: () => import('./complex-view/schema-view/schema-view.vue')
  },
]



// 侧边栏菜单
routes.push({
  path: '/view/dashboard/sider',
  component: () => import('./complex-view/sider-view/sider-view.vue'),
  children: siderRoutes,
})

// 业务拓展路由
if(typeof businessDashBoardRouterConfig === 'function'){
  businessDashBoardRouterConfig({routes,siderRoutes})
}


// 侧边栏兜底
routes.push({
  path: '/view/dashboard/sider/:chapters+',
  component: () => import('./complex-view/sider-view/sider-view.vue'),
})

boot(dashboard, { routes })
