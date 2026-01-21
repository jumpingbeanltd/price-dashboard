# Product Dashboard

A Cloudflare Workers application for managing product pricing and descriptions across Google Sheets, Zoho Inventory, and Shopify.

## Live URL

- **Custom Domain**: https://dashboard.popid.ie
- **Workers URL**: https://shrill-wood-f1c3.jumpingbeanltd.workers.dev
- **GitHub**: https://github.com/jumpingbeanltd/price-dashboard

## Features

### Product Pricing Tab
- Compare prices from Trade ID and Digital ID data sources
- Stock levels from three sources (editable):
  - **Trade** - from Google Sheets (Trade ID)
  - **Zoho** - fetched via Zoho Inventory API (editable)
  - **Shopify** - fetched via GraphQL API (editable)
- **Shopify Status** column with dropdown (Active/Draft/Archived)
- **Match Stock → Shopify** button - sync Zoho stock levels to Shopify
- **Batch Status** selector - set status for multiple products at once
- SKU-based matching with automatic deduplication
- GBP to EUR conversion using live ECB exchange rate
- Markup options: Digital ID €, +10%, +20%, +30%, +50%, +75%, +100%, +150%, +200%
- Profit calculation (selling price - Trade ID cost in EUR)
- Push selected items to Zoho Inventory
- Last Zoho update timestamp per SKU
- Sortable columns, text filters, pagination (50 per page)
- Shift-click for batch row selection
- Rounding options: €0.05, €0.10, €0.50, €1.00
- Editable fields turn yellow to indicate manual overrides

### Product Descriptions Tab
- View/edit product descriptions and uses from Google Sheets
- LLM-powered rewriting with multiple providers:
  - Claude (Anthropic)
  - OpenAI (GPT-4o)
  - Gemini (Google)
  - Tensorix (various models including DeepSeek, Qwen, GLM)
- Generates:
  - Rewritten description (2-3 paragraphs)
  - Product uses (HTML `<ul><li>` format with `<br>` spacing)
  - SEO HTML title (max 60 chars)
  - Meta description (max 155 chars)
- Sync to Shopify:
  - Product description (HTML)
  - SEO title
  - Meta description (og:description + description_tag metafield)
- Custom prompt configuration with separate SEO rules
- Batch rewrite with progress indicator
- Last updated/synced timestamps

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
│   ├── logs.html         # Zoho update logs page
│   └── debug.html        # Debug logs viewer
├── wrangler.toml         # Cloudflare config
└── README.md
```

## Data Sources

### Google Sheets
- **Spreadsheet ID**: `1AUqJof4VPh-BmE2Rm-kIR-9C_ipixOVXOJLI_DfTDxs`
- **Service Account**: `trade-id-scraper@trade-id-scraper.iam.gserviceaccount.com`
- **Sheets**:
  - `Trade-Id`: Product ID, Product Name, Price (GBP), SKU, Stock
  - `Digital Id`: _timestamp, image, name, price (GBP), sku, description
  - `Description`: SKU, Product Uses

### Exchange Rate
- Source: European Central Bank API
- Pair: EUR/GBP
- Endpoint: `https://data.ecb.europa.eu/data-detail-api/EXR.D.GBP.EUR.SP00.A`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/products` | GET | Fetch combined product data from Google Sheets |
| `/api/descriptions` | GET | Fetch product descriptions + uses |
| `/api/exchange-rate` | GET | Get current EUR/GBP exchange rate |
| `/api/zoho/update` | POST | Update single item in Zoho Inventory |
| `/api/zoho/batch-update` | POST | Batch update items in Zoho Inventory |
| `/api/zoho/stock` | GET | Get all Zoho stock levels |
| `/api/shopify/auth` | GET | Start Shopify OAuth flow |
| `/api/shopify/callback` | GET | Shopify OAuth callback |
| `/api/shopify/sync` | POST | Sync description/SEO to Shopify |
| `/api/shopify/stock` | POST | Get all Shopify stock levels and statuses |
| `/api/shopify/update-stock` | POST | Update Shopify inventory level by SKU |
| `/api/shopify/update-status` | POST | Update Shopify product status |
| `/api/debug/sheets` | GET | List all sheet names |
| `/api/debug/digitalid` | GET | View raw Digital ID data |
| `/api/debug/description` | GET | View raw Description sheet data |
| `/api/debug/sku-diff` | GET | Show SKU matching diff between sheets |
| `/api/debug/client-logs` | GET/POST | Client debug log storage |

## Cloudflare Worker Secrets

Set via `npx wrangler secret put <SECRET_NAME>`:

| Secret | Description |
|--------|-------------|
| `GOOGLE_SERVICE_ACCOUNT_B64` | Base64-encoded Google service account JSON |
| `ZOHO_CLIENT_ID` | Zoho OAuth client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth client secret |
| `ZOHO_REFRESH_TOKEN` | Zoho OAuth refresh token |
| `ZOHO_ORG_ID` | Zoho organization ID (`20095553978`) |
| `SHOPIFY_STORE` | Shopify store domain (e.g., `66421c-2.myshopify.com`) |
| `SHOPIFY_CLIENT_ID` | Shopify app client ID |
| `SHOPIFY_CLIENT_SECRET` | Shopify app client secret |

## Local Storage Keys

The frontend stores state in localStorage:

| Key | Description |
|-----|-------------|
| `price_dashboard_api_keys` | LLM API keys + default provider + Tensorix model |
| `price_dashboard_rewrite_prompt` | Custom main rewrite prompt |
| `price_dashboard_html_title_rules` | SEO title generation rules |
| `price_dashboard_meta_desc_rules` | Meta description generation rules |
| `price_dashboard_rewritten` | Cached rewritten content by SKU |
| `price_dashboard_shopify_token` | Shopify OAuth access token |
| `price_dashboard_zoho_timestamps` | Last Zoho update time per SKU |
| `price_dashboard_logs` | Zoho update logs |
| `price_dashboard_debug_logs` | Debug logs for troubleshooting |
| `price_dashboard_options` | Rewrite options (generateUsesIfEmpty, generateSeo) |
| `price_dashboard_active_tab` | Last active tab |

## Integrations

### Zoho Inventory
- **Domain**: EU (zoho.eu)
- **API Base**: `https://www.zohoapis.eu/inventory/v1`
- **Auth**: OAuth2 with refresh token (Self Client)
- **Updates**: `purchase_rate` (cost) and `rate` (selling price) in EUR
- **Stock**: `stock_on_hand` field

### Shopify
- **API Version**: 2024-10
- **Auth**: OAuth2 (token stored in browser localStorage)
- **Scopes**: `write_products,read_products,read_inventory,write_inventory`
- **Updates via GraphQL**:
  - `descriptionHtml` - product description
  - `seo.title` - HTML title tag
  - `seo.description` - og:description
  - `metafields[global.description_tag]` - meta name="description"

## Recent Updates (Jan 2026)

- **HTTP Basic Auth** protection added (username: admin)
- **Match Stock → Shopify** button to sync Zoho stock levels to Shopify
- **Shopify Status column** with dropdown (Active/Draft/Archived)
- **Batch status selector** to update multiple products at once
- **Editable stock fields** for Zoho and Shopify columns (yellow = override)
- Reordered stock columns: Trade | Zoho | Shopify
- Added Shopify inventory write permissions (`read_inventory`, `write_inventory`)
- Added Shopify and Zoho stock columns to pricing table
- Renamed "Stock" column to "Trade"
- Fixed LLM response parsing for markdown-wrapped JSON (```json blocks)
- Added `<br>` after `</li>` in product uses for better Shopify spacing
- Added null check for empty LLM responses
- Product name truncated to 24 chars in pricing table
- Inline column filters in table headers
- Sorting on all columns

## Known Issues

- Some Tensorix models (especially with empty descriptions) return empty responses - try a different model
- Shopify sync fails if SKU doesn't exist in Shopify catalog
- User's saved prompt may be outdated - click "Reset to Default" in Prompt settings to get latest SEO format
- Shopify stock fetch limited to first 250 products (pagination not implemented)

## Authentication

The dashboard is protected with HTTP Basic Auth:
- **Username**: `admin`
- **Password**: Set in `src/index.js` (`BASIC_AUTH_PASS` constant)

## Version

Current: v1.4
