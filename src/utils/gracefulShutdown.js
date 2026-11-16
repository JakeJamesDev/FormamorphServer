// Under load the proxy's pooled keep-alive connections never go idle, so server.close alone never finishes.
// Once closing, every response tells the client to drop its connection, and what is left is cut after the grace.
const DEFAULT_GRACE_MS = 60_000;

function gracefulShutdown(server, { graceMs = DEFAULT_GRACE_MS, exit = process.exit, log = console.log } = {}) {
  let closing = false;

  server.prependListener('request', (req, res) => {
    if (closing) res.setHeader('Connection', 'close');
  });

  return (signal) => {
    if (closing) return;
    closing = true;
    log(`${signal} signal received: closing HTTP server`);
    server.close(() => {
      log('HTTP server closed');
      exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      log(`Shutdown grace of ${graceMs} ms ran out: closing open connections`);
      server.closeAllConnections();
    }, graceMs).unref();
  };
}

module.exports = { gracefulShutdown, DEFAULT_GRACE_MS };
