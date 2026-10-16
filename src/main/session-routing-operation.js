// A deadline observes completion; it cannot cancel an outstanding native call.
// Callers must keep timed-out sessions blocked and refuse reuse.
function routingError(code, cause) {
  const error = new Error(`Session routing failed: ${code}`, { cause });
  error.code = code;
  return error;
}

async function runRoutingOperation(operation, stage, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch((cause) => {
        throw routingError(`${stage}_failed`, cause);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(routingError(`${stage}_timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { routingError, runRoutingOperation };
