<!DOCTYPE html>
  <html class="dark">

  <head>
    <title>{{name}}</title>
    <link href="/static/normalize.css" rel="stylesheet">
    <link href="/static/logo.png" rel="icon" type="image/x-icon">
  </head>

  <body style="margin:0">
    <div id="root"></div>
    <input id="env" value="{{env}}" style="display:none">
    <input id="options" value="{{options}}" style="display:none">
    <input id="projKey" value="{{projKey}}" style="display:none">
  </body>
  <script src="https://cdn.bootcss.com/axios/0.24.0/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/js-md5@0.8.3/src/md5.min.js"></script>
  <script type="text/javascript">
    try {
      window.projKey = document.getElementById('projKey').value
      window.env = document.getElementById('env').value
      const options = document.getElementById('options').value
      window.options = JSON.parse(options)
    } catch (e) {
      console.log(e)
    }
  </script>

  </html>