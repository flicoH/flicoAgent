import { once } from 'node:events';
import { HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeEvent } from './contracts';

const logger = new Logger('AiSse');
type SendSse = (event: string, data: unknown) => Promise<void>;

/** 将 Agent 运行事件写为对应的 SSE 事件。step 直接发送步骤对象，delta_reset 发送空对象。 */
export function sendRuntimeEvent(event: RuntimeEvent, send: SendSse): Promise<void> {
  switch (event.type) {
    case 'start':
      return send('start', { runId: event.runId, threadId: event.threadId });
    case 'delta':
      return send('delta', { content: event.content });
    case 'delta_reset':
      return send('delta_reset', {});
    case 'step':
      return send('step', event.step);
  }
}

/** 按 SSE 格式写入一帧。缓冲区写满时等待 drain，断连时结束等待。 */
async function writeEvent(
  response: Response,
  signal: AbortSignal,
  event: string,
  data: unknown,
): Promise<void> {
  signal.throwIfAborted();
  if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
    await once(response, 'drain', { signal });
  }
}

/**
 * 连接仍有效时发送 error 事件。4xx 使用原错误状态和消息，其余错误使用通用提示。
 * 上游异常可能含鉴权头，日志只记录接口路径。
 */
async function sendStreamError(
  response: Response,
  signal: AbortSignal,
  send: SendSse,
  error: unknown,
): Promise<void> {
  if (signal.aborted) return;
  const clientError = error instanceof HttpException && error.getStatus() < 500;
  if (!clientError) logger.error(`AI streaming request failed: ${response.req?.path ?? 'unknown route'}`);
  try {
    await send('error', {
      success: false,
      code: clientError ? error.getStatus() : 50000,
      message: clientError ? error.message : '网络错误，请稍候重试',
    });
  } catch (writeError) {
    if (!signal.aborted) throw writeError;
  }
}

/** 响应头发出后通过 SSE 报错，统一清理心跳与断连监听。 */
export async function respondWithSse(
  response: Response,
  work: (signal: AbortSignal, send: SendSse) => Promise<void>,
): Promise<void> {
  const abort = new AbortController();
  const onClose = () => abort.abort();
  response.once('close', onClose);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const heartbeat = setInterval(() => {
    if (!abort.signal.aborted && !response.writableNeedDrain) response.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();

  const send: SendSse = (event, data) => writeEvent(response, abort.signal, event, data);

  try {
    await work(abort.signal, send);
  } catch (error) {
    await sendStreamError(response, abort.signal, send, error);
  } finally {
    clearInterval(heartbeat);
    response.removeListener('close', onClose);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}
