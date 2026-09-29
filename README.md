> ⚠️ **This plugin is a Vibe Coding (AI-assisted) product.** The code has not been thoroughly human-reviewed or battle-tested in real environments, so **bugs and unexpected behaviour are possible**. If that bothers you, please don't download or use it. Continued use means you accept this risk.

# Bitiful S4 Quota

A SiYuan plugin that shows your Bitiful S4 free-tier usage at a glance — **API requests, egress traffic and storage** — with progress bars.

> For users who sync SiYuan with **Bitiful S4** (Settings → About → Sync → S3).

## Interface

Click the cloud icon in the top bar:

- Opening the panel **does not go online** — it shows the last known values.
  Click **"立即更新" (Refresh now)** to fetch fresh data.
- Clicking **outside the panel dismisses it**.
- Progress bar colours: blue under 80%, amber at ≥80%, red at ≥100%.

## Mobile

**Mobile is supported**, but the entry point differs from desktop:

- On desktop it's the cloud icon on the right of the top bar.
- On mobile there is no dedicated toolbar slot — the entry appears as a **"缤纷云 S4 用量"
  menu item inside the top bar's plugin menu**.

On narrow screens (≤600px) the panel automatically becomes a **bottom sheet** that slides up,
with larger touch targets. If you can't find the entry on mobile, check that the plugin is
enabled under Settings → Plugins.

## Free tier (official Bitiful terms)

| Item | Free allowance | Resets monthly | Daily cap |
|---|---|---|---|
| API requests | 100,000 / month | ✅ | 10,000 |
| Egress traffic | 10 GB / month | ✅ | 5 GB |
| Storage | 50 GiB | ❌ **never resets** | — |

Note: quotas are pooled **per account, not per bucket** (Bitiful's billing docs sum requests
across all buckets in an account). That's why this plugin accepts **multiple buckets** and
aggregates them — otherwise the percentages wouldn't reflect your real quota usage.

## Install

1. Copy the whole `siyuan-bitiful-s4-quota` folder into your workspace:
   `{workspace}/data/plugins/siyuan-bitiful-s4-quota/`
2. Restart SiYuan (or Settings → Bazaar → Downloaded → Refresh).
3. Enable it under "Downloaded".
4. Click the cloud icon → **设置 (Settings)** → enter your API Token and bucket → click **立即更新**.

No Node, pnpm or build step required.

## Configuration

| Field | Notes |
|---|---|
| **API Token** | Get it at https://console.bitiful.com/apiToken |
| **Buckets** | e.g. `my-notes-bucket`. For several buckets, comma-separate them to aggregate |
| **Auto refresh interval** | 300 seconds by default |
| **Enable auto refresh** | If off, data is only fetched when you click "Refresh now" |

Where to find your bucket name: SiYuan Settings → About → Sync → S3 → **Bucket**.

> Keeping auto refresh on is recommended: Bitiful only retains about 3 days of logs, so long
> gaps cause permanent holes in the monthly totals.

## Safety

**Zero impact on your notes.** The plugin calls only two **read-only** Bitiful endpoints
(usage and logs). It calls no SiYuan note/block/document/file APIs and never reads or modifies
your content.

**About the token:** the API Token is stored **in plaintext** in the plugin's own private folder
`{workspace}/data/storage/petal/siyuan-bitiful-s4-quota/config.json`. If you sync your workspace
it may travel to the cloud, so a dedicated token is recommended.

## Known limitations

- **Traffic is an estimate** — summed from per-response byte counts in the logs, so it may differ
  slightly from your Bitiful bill. Treat it as a trend indicator.
- The first refresh backfills whatever the log window still holds, so the accounting may start
  earlier than the plugin's install date.
- Very long refresh intervals combined with heavy traffic can cause missed records. Keep it at
  300 seconds or less.

## License

MIT
