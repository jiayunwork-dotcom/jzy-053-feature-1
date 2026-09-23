/** Runtime configuration from environment. */

import * as path from 'path';

export interface Config {
  port: number;
  host: string;
  dataFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const dataFile = path.resolve(
    env.PROFILES_FILE ?? path.join(process.cwd(), 'data', 'profiles.json'),
  );
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dataFile,
  };
}
