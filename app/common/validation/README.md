# 后续 API 的 DTO 接入模式

全局 `RequestValidationPipe` 同时处理 `@Query()` 和 `@Body()` 的 DTO class。
校验失败固定为 HTTP 200：`{ success: false, message: 'request validate fail: ...', code: 442 }`。
Controller 只处理业务，异常 Filter 原样保留 442；不在 handler 中重复校验。

## 放置与接入

每个业务模块在自己的 `dto/` 中按操作区分 query/body DTO，直接 import 具体文件。
例如后续 Product 可使用 `get-product.dto.ts`、`get-product-list.dto.ts`、
`create-product.dto.ts`、`update-product.dto.ts`。本步只约定模式，不创建或注册业务接口。

```ts
import { IsDefined, IsNumber, IsString, ValidateIf } from 'class-validator';

export class CreateProductDto {
  @IsDefined()
  @IsString()
  product_name!: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  inventory?: number;
}

// 后续对应的 Controller 方法使用 @Body() body: CreateProductDto。
// query 同样使用 @Query() query: GetProductDto，而非 interface 或单独读取字段。
```

示例仅展示必填字符串和可选数值规则，不是完整 Product DTO。
实际迁移时须补齐全部既有字段；不校验但业务会读取的字段用 `@Allow()` 保留。
`whitelist: true` 会去除没有校验装饰器的字段。

- 必填用 `@IsDefined()` 加对应类型校验，不跳过缺失字段。
- 可选但不接受 null 的字段用上述 `@ValidateIf`，避免 `@IsOptional()` 同时跳过 null。
- query 中的数字文本仍按 schema 的 string 校验；body 的 number 不隐式接受数字字符串。
  不加 `@Type(() => Number)` 或开启隐式类型转换来改变旧规则。
- 对象和数组使用 `@ValidateNested()`（数组加 `{ each: true }`）、`@Type(() => ChildDto)`，
  并分别声明 `@IsObject()` / `@IsArray()`。错误消息包含嵌套属性路径。
- DTO 必须是有装饰器的 class，且不能用 `import type` 导入到 Controller 参数位置。
- 无校验 schema 的接口不强行套一个空 DTO，避免改变其现有参数行为。

## 当前 router-schema 盘点

| 来源与接口 | 已有规则 / 后续迁移依据 |
| --- | --- |
| 框架 GET `/api/project` | query 必填 `proj_key`，字符串；已有 DTO |
| 框架 GET `/api/project/list` | query 可选 `proj_key`，字符串；已有 DTO |
| 框架 `/api/project/model_list` | schema 的 get/post/put/delete 均为空；当前仅迁移 GET 路由 |
| demo GET `/api/proj/product/list` | query required 为 `page`、`size`；properties 写的是 `pege`、`size`，均为 string |
| demo GET `/api/proj/product` | query 必填 string `product_id` |
| demo POST `/api/proj/product` | body 必填 string `product_name`；另定义 string `product_id`、`product_desc` 和 number `inventory` |
| demo PUT `/api/proj/product` | body 必填 string `product_id`；另定义 string `product_name` 和 number `price`、`inventory` |
| demo `/api/proj/product` 的 `delect` | 定义必填 body string `product_id`，但方法键拼写不是 delete，不能当作已生效的 DELETE 校验 |
| demo GET `/api/proj/product_enum/list` | 空 schema |

框架 Project schema 的 `propertes`、demo 的 `pege` / `delect` 都保留原文件。
后续迁移须明确对照 schema 的实际行为和业务读取字段，不在本步修拼写、改字段或注册路由。
当前全量 router-schema 中没有 Auth/User 规则，不预设它们的字段或约束。
