# flicoAgent

flicoAgent 是一个基于 NestJS 的应用框架内核，提供项目配置、页面与静态资源服务、业务模块自动发现，以及可选的 LLM、Agent、Skill、MCP、RAG 和会话记忆能力。前端采用 Vue 3、Vite 与 Element Plus。

本仓库包含框架源码和示例页面。框架也支持被业务工程作为 npm 包依赖；业务工程需按下文约定提供配置、页面和模块构建产物。

## 功能概览

- NestJS HTTP 服务，默认监听 `8080`
- 基于 `_ENV` 或 `__ENV` 加载环境配置
- 自动加载业务工程 `dist/modules/**/*.module.js`、`dist/skills/**/*.skill.js` 和 `dist/agents/**/*.agent.js`
- Vue 3 + Vite 多页面构建及 Nunjucks 页面模板
- 可配置的 OpenAI 兼容 LLM、Embedding、MCP 工具、RAG、Guardrail、Memory 与 Trace
- 内置文件型 Trace、Memory 和 Vector 存储实现

## 从 GitHub 克隆并运行

需要 Node.js 22.22.3（仓库的 `.nvmrc` 指定版本）和 npm 10。将下方的 `OWNER/REPO` 替换为发布后的 GitHub 仓库路径。如果发布在其他分支，将 `feature/agent` 改为对应分支名。

```bash
git clone --branch feature/agent https://github.com/OWNER/REPO.git elips
cd elips
nvm install  # 使用 nvm 时执行，读取 .nvmrc
nvm use      # 已使用指定 Node.js 版本时可跳过两条 nvm 命令
npm ci
npm run build
node -e "require('./index').frontendBuild('production')"
node -e "require('./index').serverStart()"
```

`npm run build` 将后端编译到 `dist/`。前端构建生成 `app/public/dist/entry.dashboard.tpl` 和 `app/public/dist/prod/` 下的静态资源。这些文件需要在克隆后本地生成。

打开 [示例 Dashboard](http://localhost:8080/view/dashboard)，或在另一个终端执行：

```bash
curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:8080/view/dashboard
```

返回 `200` 表示 Nest 已成功渲染页面模板。此检查无需数据库或模型密钥。Dashboard 的业务数据和功能仍依赖项目配置、业务数据及 API 验签。

### 前端开发模式

先执行 `npm run build`，再从仓库根目录分别在两个终端运行：

```bash
# 终端 1：Vite 开发服务，生成引用开发资源的模板
node -e "require('./index').frontendBuild('local')"

# 终端 2：Nest 服务
node -e "require('./index').serverStart()"
```

仍通过 `http://localhost:8080/view/dashboard` 打开页面，Vite 从 `http://127.0.0.1:9002` 提供开发资源。结束开发后，重新执行生产前端构建即可生成引用生产资源的模板。

## 作为业务工程依赖

如果此版本已发布到 npm，在业务工程中安装：

```bash
npm install @flicoh/agent
```

准备业务目录结构。框架在业务工程的 `process.cwd()` 下查找配置、静态页面、构建产物及数据目录：

```text
business-app/
├── config/
│   ├── config.default.js
│   ├── config.local.js       # 本地密钥；不要提交
│   ├── config.beta.js        # 可选
│   └── config.prod.js        # 可选
├── app/
│   ├── public/               # 页面模板与静态文件
│   └── pages/                # 业务 Vue/Vite 页面（可选）
├── src/
│   ├── modules/              # 业务 Nest 模块（可选）
│   ├── skills/               # Skill 定义（可选）
│   └── agents/               # Agent 定义（可选）
└── dist/                     # 业务代码的编译产物
    ├── modules/**/*.module.js
    ├── skills/**/*.skill.js
    └── agents/**/*.agent.js
```

从业务工程根目录启动。如果工程有 TypeScript 业务模块、Skill 或 Agent，先将其编译到上述 `dist/` 路径：

```bash
node -e "require('@flicoh/agent').serverStart()"
```

框架会扫描 `dist/modules/` 中的 Nest 模块，并扫描 Skill 与 Agent 定义；未提供这些目录时对应扩展能力为空。业务 Nest 模块需导出带有 Nest 模块元数据的模块类；Skill 和 Agent 文件需按其定义接口使用 `default export` 导出。Agent 可引用相对其编译后文件位置的 Prompt 模块。

若业务工程要构建前端资源，且其 Vite 配置可以使用本包提供的配置：

```bash
node -e "require('@flicoh/agent').frontendBuild('local')"       # 开发服务器
node -e "require('@flicoh/agent').frontendBuild('production')"  # 生产构建
```

## 配置

复制或创建 `config/config.default.js`。框架默认配置位于包内 `config/config.default.js`；业务工程可在自己的 `config/` 中覆盖。配置加载优先级由低到高为：框架默认配置、业务 `config.default.js`、当前环境配置、`serverStart(options)` 启动参数。`ai` 与 `agentConfig` 对象支持深度合并，其他顶层项按后层覆盖。

环境选择：

| 环境变量 | 读取的业务配置 | 默认值 |
| --- | --- | --- |
| `_ENV` | `local` → `config.local.js`，`beta` → `config.beta.js`，`production` → `config.prod.js` | `local` |
| `__ENV` | 同上，仅在 `_ENV` 未设置时生效 | `local` |

环境配置文件位于运行目录的 `config/` 下，文件缺失时跳过该层。仓库里的 `config.bate.js` 为旧文件名，预发覆盖需使用 `config.beta.js`。

示例 `config/config.default.js`：

```js
module.exports = {
  name: 'my-business-app',
  // 可选：页面路由等业务配置
  apiSignVerify: {
    // 仅列出确认允许免验签的 API 路径
    whiteList: [],
  },
};
```

示例 `config/config.local.js`（不要把真实密钥提交到 Git）：

```js
module.exports = {
  ai: {
    llm: {
      default: 'qwen',
      models: {
        qwen: {
          provider: 'openai-compatible',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKey: process.env.DASHSCOPE_API_KEY,
        },
      },
    },
    embedding: {
      default: 'qwen-embedding',
      models: {
        'qwen-embedding': {
          provider: 'dashscope-compatible',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'text-embedding-v3',
          apiKey: process.env.DASHSCOPE_API_KEY,
        },
      },
    },
    // 使用相对业务工程根目录的可写数据目录
    store: {
      trace: 'data/trace',
      memory: 'data/memory',
      vector: 'data/vector.json',
    },
  },
};
```

LLM/Embedding 密钥仅在实际调用相应能力时必需。Embedding provider 支持 `dashscope-compatible` 和 `openai-compatible`；LLM 内置 provider 为 `openai-compatible`。`ai.mcp` 默认关闭；如需使用 MCP，请配置服务器并启用。业务配置还可通过 `require('@flicoh/agent').serverStart({ name: 'my-app' })` 传入启动选项。

## 页面与接口

- Nest HTTP 服务监听 `8080`。
- 页面控制器通过 `/view/:page` 查找业务工程 `app/public/dist/entry.:page.tpl` 模板。
- 静态资源从业务工程 `app/public/` 提供。
- 内置项目 API 路径包括 `/api/project`、`/api/project/list` 和 `/api/project/model_list`。
- `/api/*` 默认需要请求头 `s_sign` 与 `s_t` 验签。可通过 `apiSignVerify.whiteList` 将明确的 API 路径加入白名单。页面请求不受该 API 验签守卫影响。

页面模板和业务路由的具体数据依赖业务工程配置及产物；单独克隆本框架不会自带业务项目数据或数据库内容。

## npm 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 编译 Nest/TypeScript 代码至 `dist/` |
| `npm run build:watch` | 监听模式编译 |
| `npm test` | 运行 Mocha 测试（测试脚本使用 `__ENV=local`） |
| `npm run lint` | 对 JS/Vue 文件执行 ESLint |

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `app/main.ts`、`app/app.module.ts` | Nest 启动与模块装配 |
| `app/modules/` | 内置项目、页面与回退路由模块 |
| `app/ai/` | AI Runtime、LLM、Embedding、RAG、MCP、Skill、Agent 与存储接口 |
| `app/pages/` | 框架 Vue 页面与组件 |
| `app/public/` | 框架公共资源及模板 |
| `app/vite/` | Vite 多页面构建配置 |
| `config/` | 框架默认配置及环境配置 |
| `model/` | 模型入口 |
| `test/` | Nest 和 AI 单元/集成测试 |
| |

## 故障排查

- **提示缺少模型 API Key**：确认当前环境配置文件存在、环境名正确，并且 `apiKey` 已读取到有效环境变量。
- **业务模块或 Skill/Agent 未加载**：确认在业务工程根目录启动，并确认构建产物位于 `dist/modules/`、`dist/skills/`、`dist/agents/` 对应目录且文件名符合约定。
- **页面模板或静态文件 404**：检查业务工程 `app/public/` 目录及构建输出；模板路径需匹配 `dist/entry.:page.tpl`。
- **端口占用**：当前服务端口在 `app/main.ts` 中固定为 `8080`，请先释放该端口。

## 开发规范

各功能部分的需求、实现计划和任务清单保存在 `sdd/`。开始对应部分的实现前，请先阅读该部分文档。

## License

本项目 `package.json` 声明的许可证为 ISC。发布或使用前请确认其与源文件版权声明及项目实际授权一致。
