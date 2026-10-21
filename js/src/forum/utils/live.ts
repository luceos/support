/**
 * Live updates from flarum/realtime, when it is installed.
 *
 * The realtime extension pushes a ticket or reply payload to the user's
 * private channel; forum.ts merges it into the store and announces it here.
 * Pages subscribe while they are on screen and decide what to refetch. Nothing
 * here runs at all on a forum without realtime.
 */
export type LiveKind = 'ticket' | 'reply';
export type LiveListener = (kind: LiveKind, id: string | null) => void;

const listeners = new Set<LiveListener>();

export function onLive(listener: LiveListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitLive(kind: LiveKind, id: string | null): void {
  listeners.forEach((listener) => {
    try {
      listener(kind, id);
    } catch (e) {
      console.error('[linkrobins/support] live update handler failed:', e);
    }
  });
}

/**
 * Wire the realtime channel events up, if flarum/realtime is enabled.
 *
 * The extender is looked up at initializer time rather than imported, so this
 * extension's bundle does not depend on loading after realtime's (the same
 * reason the house fof-widget integrations resolve through flarum.reg).
 */
export function installRealtime(): void {
  const w: any = window as any;
  if (!w.flarum || !w.flarum.extensions || !('flarum-realtime' in w.flarum.extensions)) return;

  let RealtimeExtend: any = null;
  try {
    RealtimeExtend = w.flarum.reg.get('flarum-realtime', 'forum/extenders/Realtime');
  } catch (e) {}
  if (!RealtimeExtend) return;

  const handle = (kind: LiveKind) => (data: any) => {
    let id: string | null = null;
    try {
      const model: any = app.store.pushPayload(data);
      id = model && typeof model.id === 'function' ? String(model.id()) : null;
    } catch (e) {
      console.error('[linkrobins/support] could not apply live update:', e);
    }
    emitLive(kind, id);
    m.redraw();
  };

  try {
    new RealtimeExtend()
      .onUserChannelEvent('linkrobinsSupportTicket', handle('ticket'))
      .onUserChannelEvent('linkrobinsSupportReply', handle('reply'))
      .extend(app, { name: 'linkrobins-support', exports: {} });
  } catch (e) {
    console.error('[linkrobins/support] realtime integration failed:', e);
  }
}

export interface LiveThrottle {
  call(): void;
  cancel(): void;
}

/**
 * Fold live updates into occasional refetches, for views that reload a list
 * rather than one ticket. Every connected staff member hears about activity
 * on every ticket, so refetching per push scales with the whole desk.
 *
 * A run waits `delay` to gather a burst (a reply usually brings a ticket push
 * with it), and runs are at least `interval` apart. While the tab is hidden
 * nothing runs; one catch-up run follows when it is shown again.
 */
export function throttleLive(run: () => void, interval = 5000, delay = 500): LiveThrottle {
  let timer: any = null;
  let lastRun = 0;
  let missed = false;

  const fire = () => {
    timer = null;
    lastRun = Date.now();
    run();
  };

  const onVisible = () => {
    if (document.hidden || !missed) return;
    missed = false;
    throttle.call();
  };

  const throttle: LiveThrottle = {
    call() {
      if (document.hidden) {
        missed = true;
        return;
      }
      if (timer) return;
      const now = Date.now();
      timer = setTimeout(fire, Math.max(delay, lastRun + interval - now));
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
      missed = false;
      document.removeEventListener('visibilitychange', onVisible);
    },
  };

  document.addEventListener('visibilitychange', onVisible);

  return throttle;
}
