/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2026 huangqinjia(flicoH)。 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-05-10 18:13:53
 * @LastEditors: flicoH
 * @LastEditTime: 2026-09-07 09:25:25
 */
/** 
 * 封装 curl 请求
 * @param {Object} options 请求参数
 * @returns {Promise} 请求结果
*/
import md5 from 'md5'
import axios from 'axios'
import { ElMessage } from "element-plus"

const curl = ({
  url, // 请求地址
  baseURL, // 基础URL
  method = 'post', // 请求方法
  headers = {}, // 请求头
  data = {}, // 请求参数
  query = {}, // 查询参数
  timeout = 10000, // 超时时间
  responseType = 'json',
  errorMessages = '网络异常', // 错误提示
}) => {
  // 接口签名处理
  const signKey = 'klx05hb3n1c9ujp8uhxbs2ikkiowp212'
  const st = Date.now()
  const signature = md5(`${signKey}_${st}`)

  const dtoHeaders = {
    ...headers,
    s_sign: signature,
    s_t: st,
  }

  if(url.indexOf('/api/proj')>-1 && window.projKey){
    dtoHeaders.proj_key = window.projKey
  }
  
  // 构造请求参数 (参数转换为 axios 参数)
  const ajaxStting = {
    url,
    method,
    headers: dtoHeaders,
    data,
    params: query,
    timeout,
  }

  return axios.request(ajaxStting).then((res) => {
    const resData = res.data || {}
    const { success, code, msg } = resData
    // 失败
    if (!success) {
      if (code === 442) {
        ElMessage.error('请求参数异常')
      } else if (code === 445) {
        ElMessage.error('请求不合法')
      } else if (code === 446) {
        ElMessage.error('缺少项目必要参数')
      } else if (code === 50000) {
        ElMessage.error(msg)
      } else {
        ElMessage.error(errorMessages)
      }
      return Promise.resolve({ success, code, msg })
    }
    
    
    // 成功
    const { data, metaData } = resData
    return Promise.resolve({ success, data, metaData })
  }).catch((error) => {
    const { message } = error

    if (message.match(/timeout/)) {
      return Promise.resolve({
        message: '请求超时',
        code: 504
      })
    }

    return Promise.resolve(error)
  })
}

export default curl
