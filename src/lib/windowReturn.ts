// A project can change while Stacki is in the background. Both ways of
// returning to the window run the same reconciliation, without a polling loop.
export function onWindowReturn(reconcile: () => void): () => void {
  const whenVisible = (): void => {
    if (document.visibilityState === 'visible') {
      reconcile();
    }
  };
  window.addEventListener('focus', whenVisible);
  document.addEventListener('visibilitychange', whenVisible);
  return () => {
    window.removeEventListener('focus', whenVisible);
    document.removeEventListener('visibilitychange', whenVisible);
  };
}
