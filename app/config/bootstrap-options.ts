export interface BootstrapOptions {
  name?: string;
  homePage?: string;
  /** 服务端 AI 配置，可覆盖业务配置文件的 ai 节点。 */
  ai?: Record<string, unknown>;
}

export const BOOTSTRAP_OPTIONS = Symbol('BOOTSTRAP_OPTIONS');
