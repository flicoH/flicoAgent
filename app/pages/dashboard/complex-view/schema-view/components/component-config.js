/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-09 13:57:07
 * @LastEditors: flicoH
 */

import createForm from "./create-form/create-form.vue";
import editForm from "./edit-form/edit-form.vue";
import detailPanel from './detail-panel/detail-panel.vue'

// 业务拓展 component 
import BusinseeComponentConfig from '$businseeComponentConfig'

const ComponentConfig = {
  createForm: {
    component: createForm
  },
  editForm: {
    component: editForm
  },
  detailPanel: {
    component: detailPanel
  }
}

export default { ...ComponentConfig, ...BusinseeComponentConfig }