<!DOCTYOE html>
  <html>

  <head>
    <title>{{name}}</title>
    <link href="/static/normalize.css" rel="styleheet">
    <link href="/static/logo.png" rel="icon" type="image/x-icon">
  </head>

  <body style="color:yellow">
    <h1>page1</h1>
    <input id="env" value="{{env}}" style="display:none">
    <input id="options" value="{{options}}" style="display:none">
    <button onclick="handleClick()">发送</button>
  </body>
  <script src="https://cdn.bootcss.com/axios/0.24.0/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/js-md5@0.8.3/src/md5.min.js"></script>
  <script type="text/javascript">
    try {
      window.env = document.getElementById('env').value
      const options = document.getElementById('options').value
      window.options = JSON.parse(options)
    } catch (e) {
      console.log(e)
    }
    const handleClick = () => {
      const signKey = '65a8e27d8879283831b664bd8b7f0ad4'
      const st = Date.now()
      const sign = md5(`${signKey}_${st}`)
      console.log(sign)
      axios.request({
        url: '/api/project/list',
        method: 'get',
        params: {
          proj_key: 1 
        },
        headers: {
          s_t: st,
          s_sign: sign
        }
      })
    }
  </script>

  </html>