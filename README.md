# Sure Bank Sync

Chrome extension that scrapes transactions from bank websites and imports them into [Sure](https://github.com/we-promise/sure) via the API.

## Supported Banks

| Bank | Account Types | How It Works |
|------|--------------|--------------|
| **SoFi** | Checking, Savings, Vaults, Credit Card | Reads Apollo state for account data, fetches transactions via GraphQL. Credit card uses a separate CSV export API. |
| **Capital One** | Credit Cards | Scrapes the account summary page, fetches transaction history via API. |
| **Venmo** | Cash, Credit Card | Scrapes statement data from the Venmo web app. |
| **Bilt** | Credit Card | Scrapes transaction data from the Bilt website. |
| **Fidelity** | Rewards Visa | Scrapes transaction data from Fidelity's rewards portal. |
| **US Bank** | Credit Cards | Fetches account and transaction data via internal APIs after login. |
| **Wells Fargo** | Credit Cards | Scrapes transaction data from Wells Fargo online banking. |
| **Target** | Circle Card | Scrapes transaction data from the Target credit card portal. |

## Setup

1. Load the extension in Chrome via `chrome://extensions` → "Load unpacked"
2. Click the extension icon and go to Settings
3. Enter your Sure instance URL and API key
4. Click Connect (approve the host permission prompt if shown)
5. Add bank accounts and map each one to a Sure account
6. Set a "Start syncing from" date for the initial sync

## How Syncing Works

Transactions are imported via Sure's CSV import API (`POST /api/v1/imports` with `type: TransactionImport`). Click **Sync Now** to sync all mapped accounts, or use the **↻** button on an individual account row.

Deduplication is handled client-side by fingerprinting each transaction (date + amount + name) against existing transactions in Sure. After each import, the extension polls the import status until Sure finishes processing before moving on to the next account.

## Categories

Each bank's category for a transaction is mapped to a Sure category before import. Mappings are kept per bank in the extension (raw bank category → Sure category).

When a sync encounters a bank category that hasn't been mapped yet, those transactions are **held back** rather than imported — they're queued locally and the **🏷 Categories** view (badge shows the count of unmapped categories) lists them. Map each one to a Sure category (or "Leave uncategorized", or create a new Sure category on the spot) and the held transactions are imported immediately. The next sync also flushes anything that became mappable in the meantime.

Sure's CSV import API ignores the category column (it never builds the category mappings the web UI uses), so categories are applied per transaction via the transactions API (`PATCH /api/v1/transactions/{id}`) right after each import. Mapping a bank category therefore targets an existing Sure category — pick one from the dropdown, or use "+ Create new in Sure…" to create it on the spot. Uncategorized bank transactions import normally without waiting.

## Transfers

Transfers are imported as regular transactions. To have Sure recognize them as transfers between accounts, set up rules in Sure that match the transfer transaction names and convert them accordingly. Without rules, transfers appear as separate income/expense entries on each account.

SoFi shows both sides of every internal transfer (e.g., "To Savings" on checking and "From Checking" on savings). The extension drops the incoming "From …" side only when it can pair it with a matching outgoing "To …" in another account — same date, opposite amount, since SoFi posts both sides instantly. The outgoing "To …" side is kept and imported, so the transfer isn't double-counted. A "From …" with no matching "To …" (e.g. the other account has no Sure mapping) is treated as a real inflow and kept.

To make the pairing reliable, SoFi banking accounts (checking, savings, vaults) are synced **as a group**: whenever a SoFi sync runs — even from a single account row — every mapped banking account is fetched over one window (the earliest pending start date) so both sides of a transfer always arrive together. Accounts without a Sure mapping are never imported, and re-fetched transactions that already exist in Sure are deduplicated on import. The credit card syncs on its own and isn't part of this pairing.

## Managing Transactions

Each account row has a **⌫** button that deletes all transactions for that account in Sure and resets its sync date, allowing a clean re-import.

The Settings view has a **Delete all transactions** button that walks through every Sure account, shows the transaction count, and asks for confirmation before deleting each one.

## Requirements

- Chrome (Manifest V3)
- A self-hosted [Sure](https://github.com/we-promise/sure) instance with the `/api/v1` REST API enabled

The extension opens bank sites in a browser window for scraping. If you're not already logged in, it brings the window to the foreground and waits for you to complete login before proceeding.

## Contributing

Contributions are welcome! Adding support for a new bank requires a content script to scrape transactions and a sync function to orchestrate the flow. See the existing bank implementations in `src/banks/` and `src/content/` for reference.

---

This extension (and this README) were largely generated with Claude Code.
