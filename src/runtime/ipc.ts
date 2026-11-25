import { request } from 'node:http';
import type { Bindings } from '../schema.js';

export async function receiveBindings(socketPath: string): Promise<Bindings> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: '/bindings', method: 'GET', timeout: 5000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('Private credential channel refused the runner.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy();
            reject(new Error('Credential inventory exceeded the supported size.'));
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Bindings);
          } catch {
            reject(new Error('The private credential channel returned invalid data.'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Private credential channel timed out.')));
    req.on('error', () => reject(new Error('Private credential channel is unavailable.')));
    req.end();
  });
}
