-- Store only daily totals. The cap makes a malformed or abused counter fail loudly.
CREATE TABLE IF NOT EXISTS activity_days (
  day TEXT PRIMARY KEY NOT NULL CHECK (length(day) = 10),
  count INTEGER NOT NULL CHECK (count >= 0 AND count <= 1000000)
);
