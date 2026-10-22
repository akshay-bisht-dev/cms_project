import { createServer } from 'node:http';
import client from 'prom-client';

/**
 * Prometheus metrics (docs/deployment.md §6). Served on a separate internal port (METRICS_PORT),
 * never through Nginx. Route labels use the matched route pattern, never the raw URL, so ids do not
 * multiply series.
 */
export function createMetrics({ service }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
  return { registry, client };
}

export function httpMetricsMiddleware({ registry }) {
  const duration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route pattern',
    labelNames: ['method', 'route', 'status_class'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  return (req, res, next) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status_class: `${Math.floor(res.statusCode / 100)}xx` });
    });
    next();
  };
}

/**
 * Gauges read at scrape time: queue depth per state, outbox lag and pending webhook deliveries.
 * A failing source sets its "up" gauge to 0 instead of failing the whole scrape.
 */
export function registerWorkerMetrics({ registry, queues, prisma, workers }) {
  const queueJobs = new client.Gauge({ name: 'queue_jobs', help: 'Jobs per queue and state', labelNames: ['queue', 'state'], registers: [registry] });
  const outboxPending = new client.Gauge({ name: 'outbox_pending', help: 'Outbox events due but not yet published', registers: [registry] });
  const outboxLag = new client.Gauge({ name: 'outbox_oldest_pending_seconds', help: 'How long the oldest due outbox event has waited', registers: [registry] });
  const webhooksDue = new client.Gauge({ name: 'webhook_deliveries_pending', help: 'Webhook deliveries waiting to be sent or retried', registers: [registry] });
  const sourceUp = new client.Gauge({ name: 'metrics_source_up', help: '1 when a metrics source could be read', labelNames: ['source'], registers: [registry] });
  const jobDuration = new client.Histogram({ name: 'job_duration_seconds', help: 'Job processing time', labelNames: ['queue', 'name'], buckets: [0.05, 0.25, 1, 5, 15, 60, 300], registers: [registry] });
  const jobFailures = new client.Counter({ name: 'job_failures_total', help: 'Failed job attempts', labelNames: ['queue', 'name', 'final'], registers: [registry] });

  for (const worker of workers) {
    worker.on('completed', (job) => {
      if (job.processedOn && job.finishedOn) jobDuration.observe({ queue: worker.name, name: job.name }, (job.finishedOn - job.processedOn) / 1000);
    });
    worker.on('failed', (job) => {
      const final = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : true;
      jobFailures.inc({ queue: worker.name, name: job?.name ?? 'unknown', final: String(final) });
    });
  }

  const collect = async () => {
    try {
      for (const queue of Object.values(queues)) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts)) queueJobs.set({ queue: queue.name, state }, n);
      }
      sourceUp.set({ source: 'redis' }, 1);
    } catch {
      sourceUp.set({ source: 'redis' }, 0);
    }
    try {
      const [outbox] = await prisma.$queryRaw`SELECT COUNT(*) AS n, MIN(available_at) AS oldest FROM outbox_events WHERE published_at IS NULL AND available_at <= NOW(3)`;
      outboxPending.set(Number(outbox.n));
      outboxLag.set(outbox.oldest ? Math.max(0, (Date.now() - new Date(outbox.oldest).getTime()) / 1000) : 0);
      const [hooks] = await prisma.$queryRaw`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'PENDING'`;
      webhooksDue.set(Number(hooks.n));
      sourceUp.set({ source: 'database' }, 1);
    } catch {
      sourceUp.set({ source: 'database' }, 0);
    }
  };
  return { collect };
}

/** Minimal internal HTTP server: GET /metrics only. `beforeScrape` refreshes scrape-time gauges. */
export function startMetricsServer({ port, registry, logger, beforeScrape }) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      await beforeScrape?.();
      res.writeHead(200, { 'Content-Type': registry.contentType }).end(await registry.metrics());
    } catch (err) {
      logger?.error({ err }, 'metrics scrape failed');
      res.writeHead(500).end();
    }
  });
  server.listen(port, () => logger?.info({ port }, 'metrics listening'));
  return server;
}
