// A second process with its own document-actor host, for the platform suite:
// another Stacki writing the same files (a cooperating writer), or one that
// dies at a chosen moment of the write protocol. Driven by one JSON argument;
// prints one JSON line per event on stdout.
//
// Jobs:
// - { mode: 'cooperate', file, id, rounds } — each round reads the file through
//   its actor, appends a line naming this process and round, and writes that
//   through writeText, witnessed by what it read. Prints every outcome.
// - { mode: 'crash', file, text, at: 'before-rename' | 'after-rename' } —
//   prints the base and the deterministic candidate checksum, then submits,
//   and kills itself with SIGKILL just before or just after the atomic rename:
//   the crash window of plan §3.5. It never reaches its verifying read.
const fs = require('node:fs');
const path = require('node:path');
const { realHost, sha256 } = require('./support.js');

const job = JSON.parse(process.argv[2]);
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const documents = realHost();

function cooperate() {
  for (let round = 0; round < job.rounds; round++) {
    const current = documents.current(job.file);
    if (!current.ok) {
      print({ tag: 'read-failed', message: current.error.message });
      continue;
    }
    const text = `${Buffer.from(current.value.bytes).toString('utf8')}${job.id}:${round}\n`;
    const report = documents.writeText(job.file, text, current.value.checksum);
    print({ tag: report.tag, reason: report.reason, round });
  }
}

function crash() {
  const base = sha256(fs.readFileSync(job.file));
  print({ tag: 'staged', base, candidate: sha256(Buffer.from(job.text, 'utf8')) });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(from).startsWith('.stacki-write-')) {
      if (job.at === 'before-rename') {
        process.kill(process.pid, 'SIGKILL');
      }
      rename(from, to);
      process.kill(process.pid, 'SIGKILL');
    }
    return rename(from, to);
  };
  documents.writeText(job.file, job.text, base);
  print({ tag: 'survived' }); // Never printed: the process dies inside the write.
}

switch (job.mode) {
  case 'cooperate':
    cooperate();
    break;
  case 'crash':
    crash();
    break;
  default:
    throw new Error(`Unknown job ${job.mode}`);
}
