const assert = require('assert');
const { of } = require('rxjs');
const { ProjKeyInterceptor } = require('../../dist/common/interceptors/proj-key.interceptor');

function context(request) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

describe('ProjKeyInterceptor', () => {
  it('只放行非 /api/proj/ 请求且不要求 proj_key', done => {
    const next = { handle: () => of('next') };
    new ProjKeyInterceptor().intercept(context({ path: '/api/auth/login', headers: {} }), next)
      .subscribe(value => {
        assert.strictEqual(value, 'next');
        done();
      });
  });

  it('缺少 proj_key 时返回 HTTP 200 + code 446 且不调用 next', () => {
    let called = false;
    const next = { handle: () => { called = true; return of('next'); } };
    assert.throws(
      () => new ProjKeyInterceptor().intercept(context({ path: '/api/proj/product/list', headers: {} }), next),
      error => {
        assert.strictEqual(error.getStatus(), 200);
        assert.deepStrictEqual(error.getResponse(), {
          success: false,
          message: 'proj_key not found',
          code: 446,
        });
        return true;
      },
    );
    assert.strictEqual(called, false);
  });

  it('把 header 中的 proj_key 写到 request.projKey 后放行', done => {
    const request = { path: '/api/proj/product/list', headers: { proj_key: 'c1' } };
    const next = { handle: () => of('next') };
    new ProjKeyInterceptor().intercept(context(request), next).subscribe(value => {
      assert.strictEqual(value, 'next');
      assert.strictEqual(request.projKey, 'c1');
      done();
    });
  });
});
