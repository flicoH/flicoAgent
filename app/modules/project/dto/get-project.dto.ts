import { IsDefined, IsString } from 'class-validator';

export class GetProjectDto {
  @IsDefined()
  @IsString()
  proj_key!: string;
}
