/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2018 ShenZhen 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-09-07 13:54:28
 * @LastEditors: flicoH
 */
import input from './complex-view/input/input.vue'
import select from './complex-view/select/select.vue'
import dynamicSelect from './complex-view/dynamic-select/dynamic-select.vue'
import dateRange from './complex-view/date-range/date-range.vue'

// 业务拓展 search-item 
import BusinessSearchItem from '$businessSearchItem'


const SearchItemConfig = {
  input: {
    component: input
  },
  select: {
    component: select
  },
  dynamicSelect: {
    component: dynamicSelect
  },
  dateRange: {
    component: dateRange,
  }
}

export default { ...SearchItemConfig, ...BusinessSearchItem }