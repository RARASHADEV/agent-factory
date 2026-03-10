// src/commands/webhook.ts
// af webhook serve — start the Loka → AF webhook listener.
// Feature-flagged behind ENABLE_AF_12.

import { createServer } from 'http';
import { ENABLE_AF_12 } from '../lib/constants.js';
import { loadConfig } from '../lib/config.js';
import { WebhookHandler } from '../lib/webhook-handler.js';
import { error } from '../lib/format.js';

export interface WebhookServeOptions {
  port?: number;
  project?: string;  // optional: restrict to single project (reserved for future use)
  verbose?: boolean;
}

const DEFAULT_PORT = 4100;

export async function webhookServeCommand(options: WebhookServeOptions): Promise<void> {
  // 1. Guard: ENABLE_AF_12
  if (!ENABLE_AF_12) {
    console.log(error('AF-12 Loka sync is not enabled. Set ENABLE_AF_12=true in constants.ts to enable.'));
    process.exit(1);
  }

  // 2. Load config, check loka.webhook.secret exists
  const config = loadConfig();

  if (!config.loka) {
    console.log(error('Loka not configured. Add loka.url and loka.apiKey to ~/.af/config.yaml'));
    process.exit(1);
  }

  if (!config.loka.webhook?.secret) {
    console.log(error(
      'Webhook secret not configured. Add loka.webhook.secret to ~/.af/config.yaml\n' +
      'Example:\n  loka:\n    webhook:\n      secret: whsec_your_shared_secret_here\n      port: 4100',
    ));
    process.exit(1);
  }

  // 3. Resolve port: options.port ?? config.loka.webhook.port ?? DEFAULT_PORT
  const port = options.port ?? config.loka.webhook.port ?? DEFAULT_PORT;
  const verbose = options.verbose ?? false;

  // 4. Create WebhookHandler instance
  const handler = new WebhookHandler(config.loka.webhook.secret, config.loka, verbose);

  // 5. Create HTTP server
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/health') {
      // Health check endpoint
      const body = JSON.stringify({ status: 'ok', uptime: process.uptime() });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (method === 'POST' && url === '/webhook') {
      await handler.handle(req, res);
      return;
    }

    // All other routes → 404
    const body = JSON.stringify({ ok: false, error: 'Not found' });
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });

  // 6. Start listening
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      resolve();
    });
  });

  console.log(`Webhook server listening on http://0.0.0.0:${port}`);
  console.log(`  POST /webhook   — Loka webhook endpoint`);
  console.log(`  GET  /health    — Health check`);
  if (verbose) {
    console.log(`  Verbose logging: on`);
  }
  console.log(`Press Ctrl+C to stop.`);

  // 7. Graceful shutdown
  const shutdown = () => {
    process.stdout.write('\nShutting down webhook server...\n');
    server.close(() => {
      process.exit(0);
    });

    // Force exit if server doesn't close within 5 seconds
    setTimeout(() => {
      process.stderr.write('Forced exit after timeout.\n');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive (the server listener does this, but be explicit)
  await new Promise<never>(() => { /* run forever until signal */ });
}
