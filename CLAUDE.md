# Product Pricing Dashboard

A Cloudflare Workers application for comparing product prices from multiple suppliers and pushing updated prices to Zoho Inventory.

## Deployment

- **Platform**: Cloudflare Workers
- **Worker Name**: `shrill-wood-f1c3`
- **URL**: https://shrill-wood-f1c3.jumpingbeanltd.workers.dev
- **Deploy Command**: `npx wrangler deploy`

## Project Structure

```
price-dashboard/
├── src/
│   └── index.js          # Cloudflare Worker (API endpoints)
├── assets/
│   ├── index.html        # Main dashboard UI
│   ├── script.js         # Frontend JavaScript
│   ├── style.css         # Custom styles
│   └── logs.html         # Change logs page
└── wrangler.toml         # Cloudflare config
```

## Data Sources

### Google Sheets
- **Spreadsheet ID**: `1AUqJof4VPh-BmE2Rm-kIR-9C_ipixOVXOJLI_DfTDxs`
- **Service Account**: `trade-id-scraper@trade-id-scraper.iam.gserviceaccount.com`
- **Sheets**:
  - `Trade-Id`: Product ID, Product Name, Price (GBP), SKU, Stock
  - `Digital Id`: _timestamp, image, name, price (GBP with £ symbol), sku, url

### Exchange Rate
- Source: European Central Bank API
- Pair: EUR/GBP
- Endpoint: `https://data.ecb.europa.eu/data-detail-api/EXR.D.GBP.EUR.SP00.A`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/products` | GET | Fetch combined product data from Google Sheets |
| `/api/exchange-rate` | GET | Get current EUR/GBP exchange rate |
| `/api/zoho/update` | POST | Update single item in Zoho Inventory |
| `/api/zoho/batch-update` | POST | Batch update items in Zoho Inventory |
| `/api/debug/sheets` | GET | List all sheet names |
| `/api/debug/digitalid` | GET | View raw Digital ID data |

## Cloudflare Worker Secrets

Set via `npx wrangler secret put <SECRET_NAME>`:

| Secret | Description |
|--------|-------------|
| `GOOGLE_SERVICE_ACCOUNT_B64` | Base64-encoded Google service account JSON |
| `ZOHO_CLIENT_ID` | Zoho OAuth client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth client secret |
| `ZOHO_REFRESH_TOKEN` | Zoho OAuth refresh token |
| `ZOHO_ORG_ID` | Zoho organization ID (`20095553978`) |

## Zoho Inventory Integration

- **Domain**: EU (zoho.eu)
- **API Base**: `https://www.zohoapis.eu/inventory/v1`
- **Auth**: OAuth2 with refresh token (Self Client)
- **Updates**: `purchase_rate` (cost price in EUR) and `rate` (selling price in EUR)
- Items are matched by SKU

## Features

- SKU-based matching between Trade-Id and Digital Id sheets
- Automatic deduplication (first occurrence kept)
- Records without matching prices from both sources are filtered out
- GBP to EUR conversion using live ECB exchange rate
- Sortable columns, text filters (SKU/Name), pagination (50 per page)
- Shift-click for batch row selection
- Identity price column with dropdown options:
  - Digital ID € (converted price)
  - +10%, +20%, +25%, +40% markup options
- Editable price inputs with manual override (yellow highlight)
- Rounding options: €0.05, €0.10, €0.50, €1.00
- Push selected items to Zoho Inventory (cost in EUR, selling price in EUR)
- Change logs stored in localStorage (View Logs link in footer)

## Key Code Locations

- **Google Sheets auth**: `src/index.js:11-78` (JWT creation, token exchange)
- **Sheet parsing**: `src/index.js:103-147` (parseTradeIdSheet, parseDigitalIdSheet)
- **Data combination/dedup**: `src/index.js:152-184` (combineData)
- **Zoho API calls**: `src/index.js:202-250` (getZohoAccessToken, zohoSearchItemBySku, zohoUpdateItemPrices)
- **EUR conversion**: `assets/script.js:113-116` (gbpToEur)
- **Identity price calc**: `assets/script.js:118-143` (calculateIdentityPrice)
- **Zoho push with logging**: `assets/script.js:549-630`
- **Log storage**: `assets/script.js:13-40` (saveLog, getLogs)

## Version

Current: v1.0
