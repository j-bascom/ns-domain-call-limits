# Set SkySwitch Domain Call Paths

A small tool that sets the **external call path limit** (`call_limit_ext`) on every
domain in your SkySwitch / NetSapiens territory, sized to how many devices each
domain actually has. It signs in to your NS-API for you, reads each domain's live
device count, and applies a limit using a simple formula you control.

It **always previews first** (a dry run that writes nothing) and only makes changes
after you choose to apply and confirm.

---

## What you need

- **Node.js 18 or newer** (free). Download the LTS installer from <https://nodejs.org>.
- Your SkySwitch **API credentials**: territory code, username, password, and
  (if your account uses one) an OAuth client secret.

To check whether Node.js is already installed, open a terminal and run:

```
node --version
```

If it prints `v18` or higher, you're ready. If it says "not recognized", install Node.js first.

---

## How to run it

### Windows (easiest)

1. Install Node.js from <https://nodejs.org> if you haven't.
2. **Double-click `run.bat`.**

A console window opens and walks you through the questions. If Node.js isn't
installed, `run.bat` tells you where to get it.

*(You can also open PowerShell or Command Prompt in this folder and run
`node set-domain-call-limits-standalone.js`.)*

### macOS / Linux

Open a terminal in this folder and run:

```
node set-domain-call-limits-standalone.js
```

### Docker (any operating system, no Node.js install needed)

```
docker run -it --rm -v "$PWD":/w -w /w node:20 node set-domain-call-limits-standalone.js
```

---

## What it asks you

| Prompt | Meaning | Default |
|---|---|---|
| **Territory code** | Your SkySwitch territory number (e.g. `12345`). The tool signs in at `https://{territory}-hpbx.dashmanager.com`. | — |
| **OAuth client_id** | Usually `{territory}.n8n`. | `{territory}.n8n` |
| **API username / password** | Your SkySwitch API login. The password is hidden as you type. | — |
| **OAuth client_secret** | Only if your account requires one. Leave blank otherwise. | blank |
| **Minimum call paths** | The fewest paths any domain will get (a floor). | `4` |
| **Maximum call paths** | The most paths any domain will get (a cap). | `30` |
| **Call-paths-per-device ratio** | Paths per device before the floor/cap are applied. | `0.75` |
| **Apply changes?** | `n` = preview only (dry run). `y` = make changes (asks again to confirm). | `n` |

### The formula

```
call paths = round( device count x ratio ),  then kept between minimum and maximum
```

Example with the defaults (ratio 0.75, min 4, max 30):

| Devices | Call paths |
|---:|---:|
| 0–5 | 4 |
| 8 | 6 |
| 10 | 8 |
| 20 | 15 |
| 40 or more | 30 |

Change the ratio, minimum, or maximum at the prompts to tune this to your needs.

---

## Recommended first run

1. Run it and answer **`n`** to "Apply changes?" — this is a **dry run**.
2. Review the printed table (`domain, deviceCount, currentLimit, newLimit, action`).
   `would-update` rows show what *would* change; `unchanged` rows are already correct.
3. If the numbers look right, run it again and answer **`y`**, then confirm.

> **Note:** On many systems a `call_limit_ext` of `0` means *no limit (unlimited)*.
> If your domains currently show `0`, applying this tool replaces "unlimited" with a
> finite number of paths. That's usually the goal (sizing capacity to real usage),
> but review the dry run so you know exactly what changes.

---

## Speed and rate limits

The tool is deliberately gentle on the API: it makes at most about **one request
every two seconds**, so a territory with ~150 domains takes several minutes. If the
API ever returns "too many requests" (HTTP 429), the tool **pauses 30 seconds and
retries automatically** (up to 5 times per request). You can leave it running.

If a few domains error out (e.g. a network blip), just run the tool again — domains
that are already correct are skipped as `unchanged`, so it only fixes the rest.

---

## Running unattended (optional)

Every prompt can be pre-filled with an environment variable, so the tool can run
without asking any questions — handy for scheduling or automation.

| Variable | Prompt it replaces |
|---|---|
| `SS_TERRITORY` | Territory code |
| `SS_CLIENT_ID` | OAuth client_id |
| `SS_USERNAME` | API username |
| `SS_PASSWORD` | API password |
| `SS_CLIENT_SECRET` | OAuth client_secret (set empty for none) |
| `SS_MIN` | Minimum call paths |
| `SS_MAX` | Maximum call paths |
| `SS_RATIO` | Call-paths-per-device ratio |
| `SS_APPLY` | `yes` to write, `no` for dry run |
| `SS_BASE_URL` | Override the NS-API host (advanced; normally leave unset) |
| `SS_RATE_MS` | Minimum milliseconds between API calls (default `2200`) |

Example (macOS/Linux):

```
SS_TERRITORY=12345 SS_USERNAME=me SS_PASSWORD=secret SS_APPLY=no \
  node set-domain-call-limits-standalone.js
```

Example (Windows PowerShell):

```powershell
$env:SS_TERRITORY="12345"; $env:SS_USERNAME="me"; $env:SS_PASSWORD="secret"; $env:SS_APPLY="no"
node set-domain-call-limits-standalone.js
```

---

## Safety summary

- Dry run by default — nothing changes unless you choose to apply **and** confirm.
- Only domains whose limit actually differs are updated; correct ones are skipped.
- The admin/system domain (`0000`) is always skipped.
- Your password is entered at a hidden prompt and is never displayed or saved.
