const http = require('http');
exports.request = (server, path, { method = 'GET', body, cookie, token = 'member', host } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: cookie } : {}), ...(host ? { Host: host } : {}) } }, res => {
    let text = ''; res.on('data', data => { text += data; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
      body: String(res.headers['content-type']).includes('application/json') ? JSON.parse(text) : null,
      cookie: res.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
exports.listen = app => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.on('error', reject);
});
