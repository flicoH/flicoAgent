import { createHash, createHmac } from 'node:crypto';

export function agentRequestSignature(
  secret: string, keyId: string, method: string, path: string, timestamp: string, nonce: string, body: string | Buffer,
): Buffer {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret)
    .update([keyId, method.toUpperCase(), path, timestamp, nonce, digest].join('\n')).digest();
}
