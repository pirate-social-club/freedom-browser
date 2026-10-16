// Native drainage failure needs an immediate Electron boundary. Normal quit
// awaits helper shutdown, which can enqueue routing and deadlock this queue.
function createSessionRoutingTermination({ app, log, markQuitting, recordNotice = () => {} }) {
  if (typeof app?.exit !== 'function') throw new TypeError('Electron termination is unavailable');
  let invoked = false;
  return (code) => {
    if (invoked) return;
    invoked = true;
    try { recordNotice(code); } catch { /* Persistence cannot veto termination. */ }
    try {
      markQuitting();
      log.error(`[Network] session_routing_terminal: ${code}`);
    } catch {
      // A failed log transport cannot postpone the termination boundary.
    } finally {
      app.exit(70);
    }
  };
}

module.exports = { createSessionRoutingTermination };
