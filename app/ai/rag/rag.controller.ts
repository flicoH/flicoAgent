import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Post, Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { citationChunk, retrievalOutput } from './citations';
import { RagDirectoryNotFound } from './rag-source';
import { RetrieverService } from './retriever.service';

function checkAccess(request: Request, write = false): void {
  const access = request.agentRunAccess;
  if (access?.ingest === true || (!write && access?.ragRead === true)) return;
  throw new ForbiddenException('RAG operation is not allowed');
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new BadRequestException(`Invalid ${field}`);
  }
  return value;
}

@Controller('api/ai/rag')
export class RagController {
  constructor(private readonly retriever: RetrieverService) {}

  @Get('documents')
  async documents(@Req() request: Request) {
    checkAccess(request);
    const data = await this.retriever.listDocuments();
    return { success: true as const, data };
  }

  @Delete('documents')
  async deleteDocument(@Req() request: Request, @Body() body?: { docId?: unknown }) {
    checkAccess(request, true);
    const docId = requiredText(body?.docId, 'docId', 1024);
    const removed = await this.retriever.deleteDocument(undefined, docId);
    if (!removed) throw new NotFoundException('Indexed document not found');
    return { success: true as const, data: { docId, removed } };
  }

  @Post('rebuild')
  async rebuild(@Req() request: Request) {
    checkAccess(request, true);
    try {
      const data = await this.retriever.rebuild();
      return { success: true as const, data };
    } catch (error) {
      if (error instanceof RagDirectoryNotFound) throw new NotFoundException(error.message);
      throw error;
    }
  }

  @Post('preview')
  async preview(@Req() request: Request, @Body() body?: { query?: unknown; topK?: unknown }) {
    checkAccess(request);
    const query = requiredText(body?.query, 'query', 4096).trim();
    const topK = body?.topK;
    if (topK !== undefined && (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 100)) {
      throw new BadRequestException('Invalid topK');
    }
    const { hits } = await this.retriever.preview(undefined, query, topK);
    return { success: true as const, data: retrievalOutput(hits) };
  }

  @Get('chunk')
  async chunk(@Req() request: Request, @Query('id') id?: unknown) {
    checkAccess(request);
    const chunk = await this.retriever.loadChunk(undefined, requiredText(id, 'id', 4096));
    if (!chunk) throw new NotFoundException('Indexed chunk not found');
    return { success: true as const, data: citationChunk(chunk) };
  }

  @Get('wiki/pages')
  async wikiPages(@Req() request: Request) {
    checkAccess(request);
    return { success: true as const, data: await this.retriever.listWikiPages() };
  }

  @Get('wiki/page')
  async wikiPage(@Req() request: Request, @Query('id') id?: unknown) {
    checkAccess(request);
    const page = await this.retriever.loadWikiPage(requiredText(id, 'id', 80));
    if (!page) throw new NotFoundException('Wiki page not found');
    return { success: true as const, data: page };
  }
}
