/**
 * On stdio, the client closing stdin is the end of the session: the Matrix client's timers and sync would otherwise
 * keep the process (and its store lock) alive. On Windows a client cannot send a catchable signal, so this is also
 * the only clean stop it has.
 */
export function stopWhenStdinEnds(stdin: NodeJS.ReadableStream & { readableEnded?: boolean }, stop: () => void): void {
  if (stdin.readableEnded) {
    stop();
    return;
  }
  stdin.once('end', stop);
}
