# Anonymous daily usage counts

The installed app attempts one empty POST after a project opens on a UTC day, once
the one-time notice has been shown. File → Anonymous Usage Counts turns this off.
Development builds send nothing. The Worker ignores request bodies and stores
only a date and total count in D1; it does not read or store IP addresses,
project data, installation IDs, or event histories. Rows older than 366 days
are deleted daily. Counts represent active installations, not distinct people.

The endpoint is deployed from `wrangler.jsonc` in this directory. Its D1
database is `stacki-usage-counts` in the account named in that config. Deploy
the schema before the Worker, then deploy the Worker:

```sh
npm exec --yes --package wrangler -- wrangler d1 execute stacki-usage-counts --remote --file=services/usageCounts/schema.sql --config services/usageCounts/wrangler.jsonc
npm exec --yes --package wrangler -- wrangler deploy --config services/usageCounts/wrangler.jsonc
```

Read the totals in the Cloudflare D1 dashboard or run:

```sh
npm exec --yes --package wrangler -- wrangler d1 execute stacki-usage-counts --remote --config services/usageCounts/wrangler.jsonc --command 'SELECT day, count FROM activity_days ORDER BY day DESC LIMIT 30'
```

The endpoint is intentionally limited to aggregate audience measurement. Do not
add interaction events, IP-derived IDs, or project properties to this counter.
