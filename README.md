# moona

A CLI for [Noona.is](https://noona.is) — Iceland's dominant booking platform. Search
businesses, check availability, book appointments, and cancel them. All from the
terminal, no browser required.

Built for [OpenClaw](https://github.com/openclaw/openclaw) setups where your AI
agent needs to actually _do things_ in the real world, not just talk about doing
them. Your lobster wants a haircut? Now it can book one.

## Setup

```bash
bun install
bun run index.ts login    # phone number + SMS code
```

Or skip the login flow and drop your JWT token directly:

```bash
echo '<your-noona-jwt>' > ~/.noona-token
```

The token is a long-lived HS256 JWT issued per phone number. It does not expire
(seriously). Grab one from the browser DevTools `Authorization` header if the
login flow gives you trouble.

## Usage

```
bun run index.ts <command> [args]
```

| Command | Description |
|---|---|
| `login` | Authenticate with phone + SMS |
| `me` | Who am I |
| `search <query>` | Find businesses |
| `services <company_id>` | List bookable services with prices |
| `slots <company> <service> [date]` | Show available time slots (7 days) |
| `next <company> <service> [date]` | Find the next available slot in a wider window |
| `book <company> <service> <datetime> [employee]` | Book an appointment |
| `book-next <company> <service> [date] [employee]` | Find and book the next available slot automatically |
| `cancel <event_id>` | Cancel a booking |
| `bookings` | List upcoming bookings |

## Example: book a haircut

```bash
# Find the shop
bun run index.ts search "Skuggi"
# → Company: p6bgkzYaew8gpQrxT

# What do they offer?
bun run index.ts services p6bgkzYaew8gpQrxT
# → Barnaklipping | ID: fCvza4R8BLRS7gHnh | 30min | 5,900 ISK

# Show upcoming slots
bun run index.ts slots p6bgkzYaew8gpQrxT fCvza4R8BLRS7gHnh 2026-03-30

# Or just ask for the next one
bun run index.ts next p6bgkzYaew8gpQrxT fCvza4R8BLRS7gHnh 2026-03-30

# Book an exact slot
bun run index.ts book p6bgkzYaew8gpQrxT fCvza4R8BLRS7gHnh 2026-03-30T11:30:00Z kmtPSWQ7LDuWh2XSr

# Or let moona find and book the next available slot for you
bun run index.ts book-next p6bgkzYaew8gpQrxT fCvza4R8BLRS7gHnh 2026-03-30

# Changed your mind?
bun run index.ts cancel 2MypYGIJbBhYGzYo2cJiTKK1
```

## How booking works

1. **Reserve** — `POST /time_slot_reservations` creates a 5-minute hold
2. **Confirm** — `POST /events` converts it into a real booking using your
   profile (name, phone, email, kennitala)
3. Services requiring prepayment are blocked to avoid accidental charges

## OpenClaw integration

Point your agent at this CLI. The commands are stateless and composable, but now
it can also do the common “just find the next available appointment and book it”
flow directly.

Good general flow:
- `search` to find the business
- `services` to inspect offerings
- `next` to find the earliest availability
- `book-next` to book it immediately

The token lives at `~/.noona-token` so it persists across sessions. No browser,
no cookies, no OAuth dance. Just a JWT and a phone number.

## Notes

- `book` now accepts ISO datetimes without timezone suffix and assumes `Z`
- `next` searches a broader rolling window, useful when the 7-day `slots` view is empty
- `book-next` is intended for agents and other automation where minimizing back-and-forth matters

## API notes

The Noona marketplace API lives at `https://api.noona.is/v1/marketplace`. Auth
is a permanent HS256 JWT with your phone number baked in. The field for
Icelandic national ID is `ssn` (not `kennitala` like the rest of the API calls
it). Some businesses require manual approval — your booking will show as
"pending" until they confirm.

Docs (sparse): [docs.noona.is](https://docs.noona.is/docs)

## License

Do whatever you want with this.
