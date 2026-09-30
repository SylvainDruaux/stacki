import fs from 'fs';
import path from 'path';

interface WatchProjectDeps {
  readonly projectPath: string;
  readonly send: (channel: string, payload: unknown) => void;
  readonly isSelfWrite: (absolutePath: string) => boolean;
  /** An outside change to a source file: the document actors' hint (plan §7). */
  readonly noteExternalChange: (absolutePath: string) => void;
  readonly notePageMayHaveChanged: (changed: boolean) => void;
  readonly scheduleThumb: (projectPath: string, delayMs: number) => void;
  readonly mediaPattern: RegExp;
  readonly watch?: typeof fs.watch;
}

// Both directory watchers and every queued notification belong to one open
// project. Closing it cancels the whole group before another project can hear
// an event or a timer left over from the old one.
function watchProject({
  projectPath,
  send,
  isSelfWrite,
  noteExternalChange,
  notePageMayHaveChanged,
  scheduleThumb,
  mediaPattern,
  watch = fs.watch,
}: WatchProjectDeps): { close: () => void } {
  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const files = new Set<string>();
  let closed = false;
  const debounce = (channel: string, delay = 200): void => {
    clearTimeout(timers.get(channel));
    timers.set(
      channel,
      setTimeout(() => {
        timers.delete(channel);
        if (closed) {
          return;
        }
        const payload = channel === 'fs:changed' ? { files: [...files] } : {};
        if (channel === 'fs:changed') {
          files.clear();
        }
        send(channel, payload);
      }, delay),
    );
  };
  const close = (): void => {
    closed = true;
    for (const watcher of watchers) {
      watcher.close();
    }
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    files.clear();
  };

  try {
    const srcDir = path.join(projectPath, 'src');
    watchers.push(
      watch(srcDir, { recursive: true }, (_event, filename) => {
        if (closed || !filename) {
          return;
        }
        const name = filename.toString();
        const changed = path.join(srcDir, name);
        // Comparing self writes can read the file. Do it once per event, before
        // routing it to the panels interested in that kind of file.
        if (isSelfWrite(changed)) {
          return;
        }
        noteExternalChange(changed);
        notePageMayHaveChanged(true);
        if (/\.json$/i.test(name)) {
          return debounce('cms:changed');
        }
        if (mediaPattern.test(name)) {
          return debounce('assets:changed');
        }
        if (/\.css$/i.test(name)) {
          return debounce('css:changed');
        }
        if (!/\.(astro|md|mdx|html)$/i.test(name)) {
          return;
        }
        files.add(changed);
        scheduleThumb(projectPath, 60000);
        debounce('fs:changed', 150);
      }),
    );

    const publicDir = path.join(projectPath, 'public');
    if (fs.existsSync(publicDir)) {
      watchers.push(
        watch(publicDir, { recursive: true }, (_event, filename) => {
          if (closed || (filename && String(filename).startsWith('.'))) {
            return;
          }
          if (filename && isSelfWrite(path.join(publicDir, filename.toString()))) {
            return;
          }
          debounce('assets:changed');
        }),
      );
    }
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}

export { watchProject };
