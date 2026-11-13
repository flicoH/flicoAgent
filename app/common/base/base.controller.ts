export class BaseController {
  protected success(data: unknown = {}, metaData: unknown = {}, msg = 'success') {
    return {
      success: true,
      code: 0,
      msg,
      data,
      metaData,
    };
  }

  protected fail(msg: string, code?: number) {
    return {
      success: true,
      code: code || 1,
      msg,
    };
  }
}
