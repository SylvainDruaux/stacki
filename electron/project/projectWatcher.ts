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
  const notifier = createNotifier(send);
  const close = (): void => {
    notifier.close();
    for (const watcher of watchers) {
      watcher.close();
    }
  };

  try {
    const sourceDirectory = path.join(projectPath, 'src');
    watchers.push(
      watch(sourceDirectory, { recursive: true }, (_event, filename) => {
        if (notifier.isClosed() || !filename) {
          return;
        }
        const name = filename.toString();
        const changed = path.join(sourceDirectory, name);
        // Comparing self writes can read the file. Do it once per event, before
        // routing it to the panels interested in that kind of file.
        if (isSelfWrite(changed)) {
          return;
        }
        noteExternalChange(changed);
        notePageMayHaveChanged(true);
        const channel = sourceChangeChannel(name, mediaPattern);
        if (channel === 'fs:changed') {
          notifier.addFile(changed);
          scheduleThumb(projectPath, 60000);
          notifier.debounce(channel, 150);
        } else if (channel !== undefined) {
          notifier.debounce(channel);
        }
      }),
    );

    const publicDirectory = path.join(projectPath, 'public');
    if (fs.existsSync(publicDirectory)) {
      watchers.push(
        watch(publicDirectory, { recursive: true }, (_event, filename) => {
          if (notifier.isClosed() || (filename && String(filename).startsWith('.'))) {
            return;
          }
          if (filename && isSelfWrite(path.join(publicDirectory, filename.toString()))) {
            return;
          }
          notifier.debounce('assets:changed');
        }),
      );
    }
  } catch (error: unknown) {
    close();
    throw error;
  }
  return { close };
}

type ChangeChannel = 'cms:changed' | 'assets:changed' | 'css:changed' | 'fs:changed';

// The panel a changed file under src/ concerns, or undefined when none does.
function sourceChangeChannel(name: string, mediaPattern: RegExp): ChangeChannel | undefined {
  if (/\.json$/i.test(name)) {
    return 'cms:changed';
  }
  if (mediaPattern.test(name)) {
    return 'assets:changed';
  }
  if (/\.css$/i.test(name)) {
    return 'css:changed';
  }
  if (/\.(astro|md|mdx|html)$/i.test(name)) {
    return 'fs:changed';
  }
  return undefined;
}

interface Notifier {
  readonly debounce: (channel: ChangeChannel, delayMs?: number) => void;
  readonly addFile: (file: string) => void;
  readonly isClosed: () => boolean;
  readonly close: () => void;
}

// One timer per channel, so a burst of events sends each channel once. The
// changed page files ride along with `fs:changed` and are cleared as it goes.
function createNotifier(send: WatchProjectDeps['send']): Notifier {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const files = new Set<string>();
  let closed = false;
  const debounce = (channel: ChangeChannel, delayMs = 200): void => {
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
      }, delayMs),
    );
  };
  const close = (): void => {
    closed = true;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    files.clear();
  };
  return { debounce, addFile: (file) => files.add(file), isClosed: () => closed, close };
}

export { watchProject };
