# Product Dashboard

A Cloudflare Workers application for managing product pricing and descriptions, with Zoho Inventory integration.

## Live URL

- **Custom Domain**: https://dashboard.popid.ie
- **Workers URL**: https://shrill-wood-f1c3.jumpingbeanltd.workers.dev

## Features

### Product Pricing Tab
- Compare prices from Trade ID and Digital ID data sources
- SKU-based matching with automatic deduplication
- GBP to EUR conversion using live ECB exchange rate
- Markup options: Digital ID €, +10%, +20%, +30%, +40%, +50%, +75%, +100%, +150%, +200%
- Profit calculation (selling price - Trade ID cost in EUR)
- Push selected items to Zoho Inventory
- Last Zoho update timestamp per SKU
- Sortable columns, text filters, pagination (50 per page)
- Shift-click for batch row selection
- Rounding options: €0.05, €0.10, €0.50, €1.00
- Change logs stored in localStorage

### Product Descriptions Tab
- Coming soon...

## Deployment

```bash
cd /Users/snail/Desktop/claude/pop/price-description-dashboard
npx wrangler deploy
```

## Project Structure

```
price-description-dashboard/
├── src/
│   └── index.js          # Cloudflare Worker (API endpoints)
├── assets/
│   ├── index.html        # Main dashboard UI (tabbed interface)
│   ├── script.js         # Frontend JavaScript
│   ├── style.css         # Custom styles
│   └── logs.html         # Change logs page
├── wrangler.toml         # Cloudflare config
└── README.md
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
| `/api/debug/sku-diff` | GET | Show SKU matching diff between sheets |

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
- **Updates**: `purchase_rate` (Trade ID cost in EUR) and `rate` (selling price in EUR)
- Items are matched by SKU

## Data Processing

- Records with price = -1 are filtered out from both sheets
- Both Trade ID and Digital ID sheets are deduplicated (first occurrence kept)
- SKU matching statistics available at `/api/debug/sku-diff`

## Version

Current: v1.1
