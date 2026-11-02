import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
export interface RecordedRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}
export async function fakeServer(
  handler: (request: RecordedRequest, response: ServerResponse, raw: IncomingMessage) => unknown,
) {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const recorded = {
        path: request.url ?? '',
        method: request.method ?? '',
        authorization: request.headers.authorization,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      };
      requests.push(recorded);
      await handler(recorded, response, request);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
