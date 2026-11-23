// This channel stays between the extension service worker and its offscreen document.
export function readOverPort(deliver, signal, lost, lifetime) {
  signal.throwIfAborted();
  lifetime?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const { port1: port, port2 } = new MessageChannel();
    let body, pulling, timer, done = false;
    function arm() { clearTimeout(timer); timer = setTimeout(() => close(lost()), 90000); }
    function close(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort); lifetime?.removeEventListener('abort', disconnect);
      port.postMessage({ type: 'cancel' });
      port.close();
      if (error) { reject(error); body?.error(error); }
      pulling?.();
    }
    const abort = () => close(signal.reason);
    const disconnect = () => close(lost());
    signal.addEventListener('abort', abort, { once: true }); lifetime?.addEventListener('abort', disconnect, {once:true});
    arm();
    port.onmessageerror = () => close(lost());
    port.onmessage = ({data}) => {
      if (done) return;
      clearTimeout(timer);
      if (data.type === 'error') {
        const error = Object.assign(new Error(data.message), data.flags);
        close(error);
      } else if (data.type === 'head') {
        const stream = new ReadableStream({
          start(controller) { body = controller; },
          pull() { return new Promise(resolve => { pulling = resolve; arm(); port.postMessage({ type: 'pull' }); }); },
          cancel() { close(); }
        }, { highWaterMark: 0 });
        resolve({ status: data.status, ok: data.status >= 200 && data.status < 300, url: data.url,
          headers: new Headers(data.headers), fromPlayer: data.fromPlayer, body: stream });
      } else if (data.type === 'chunk') { body.enqueue(data.bytes); pulling?.(); pulling = null; }
      else if (data.type === 'end') { body.close(); close(); }
    };
    try { deliver(port2); } catch (error) { port2.close(); close(error); }
  });
}
