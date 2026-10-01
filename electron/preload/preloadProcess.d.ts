// Electron's own typings never declare process.isMainFrame on the renderer's
// process object, though the docs and runtime do expose it (the preload runs
// once per frame, and this flag separates the app window from the preview and
// canvas frames it hosts). Declared here, ambient, so the guard at the top of
// preload.ts is typed. Delete when electron's shipped typings grow the member.
declare namespace NodeJS {
  interface Process {
    /** Whether this preload instance runs in the top-level frame. */
    readonly isMainFrame: boolean;
  }
}
