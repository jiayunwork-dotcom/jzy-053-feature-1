/**
 * Service entry point. Loads the persistent profile registry (seeding the
 * hand-checkable demo profile on first start), then serves HTTP forever.
 */

import { createApp } from './app';
import { loadConfig } from './config';
import { ProfileStore } from './profileStore';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await ProfileStore.open({ filePath: config.dataFile });
  const app = await createApp(store);

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `thin-airfoil-service listening on http://${config.host}:${config.port} ` +
        `(profiles: ${config.dataFile})`,
    );
  });

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start service:', err);
  process.exit(1);
});
