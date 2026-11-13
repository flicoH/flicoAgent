/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-09 17:05:16
 * @LastEditors: flicoH
 */
import input from './complex-view/input/input.vue'
import inputNumber from './complex-view/input-number/input-number.vue'
import select from './complex-view/select/select.vue'

// 业务拓展 form-item 
import BusinseeFormItemConfig from '$businseeFormItemConfig'

const FormItemConfig = {
  input: {
    component: input
  },
  inputNumber: {
    component: inputNumber
  },
  select: {
    component: select
  }
}

console.log(BusinseeFormItemConfig)
export default { ...FormItemConfig, ...BusinseeFormItemConfig }