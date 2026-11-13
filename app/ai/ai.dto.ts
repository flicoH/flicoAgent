import { Allow, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class AgentRunRequestBody {
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  agent!: string;

  // Agent 自行定义输入结构，框架仅保留字段并检查是否提供。
  @Allow()
  input!: unknown;

  @ValidateIf((_request, value) => value !== undefined)
  @IsString()
  @Matches(/^\s*[a-zA-Z0-9_-]{1,128}\s*$/)
  threadId?: string;
}
