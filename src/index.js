// Google Sheets configuration
const SPREADSHEET_ID = '1AUqJof4VPh-BmE2Rm-kIR-9C_ipixOVXOJLI_DfTDxs';
const SHEETS = {
  tradeId: 'Trade-Id',
  digitalId: 'Digital Id',
  description: 'Description'
};

// Debug log cache key
const DEBUG_CACHE_KEY = 'https://dashboard.popid.ie/debug-logs-cache';

// Shopify configuration - set these in wrangler.toml or Cloudflare dashboard
const SHOPIFY_SCOPES = 'write_products,read_products,read_inventory,write_inventory';
const SHOPIFY_API_VERSION = '2024-10';

/**
 * Create a JWT token for Google Sheets API authentication
 */
async function createJWT(serviceAccount) {
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  // Import the private key and sign
  const privateKey = serviceAccount.private_key;
  const pemContents = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '');

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${unsignedToken}.${encodedSignature}`;
}

/**
 * Get an access token from Google OAuth
 */
async function getAccessToken(serviceAccount) {
  const jwt = await createJWT(serviceAccount);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get access token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Fetch data from a Google Sheet
 */
async function fetchSheet(accessToken, sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch sheet ${sheetName}: ${error}`);
  }

  const data = await response.json();
  return data.values || [];
}

/**
 * Parse trade-id sheet data
 * Columns: Product ID, Product Name, Price, SKU, Stock, Release Date, Discontinued, Expected Stock, Variations, Gallery URLs
 */
function parseTradeIdSheet(rows) {
  if (rows.length < 2) return [];

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Find column indices
  const idIdx = headers.findIndex(h => h.toLowerCase().includes('product id'));
  const nameIdx = headers.findIndex(h => h.toLowerCase().includes('product name'));
  const priceIdx = headers.findIndex(h => h.toLowerCase() === 'price');
  const skuIdx = headers.findIndex(h => h.toLowerCase() === 'sku');
  const stockIdx = headers.findIndex(h => h.toLowerCase() === 'stock');

  return dataRows.map(row => ({
    productId: row[idIdx] || '',
    name: row[nameIdx] || '',
    price: parseFloat(row[priceIdx]) || null,
    sku: row[skuIdx] || '',
    stock: parseInt(row[stockIdx]) || null
  })).filter(item => item.sku && item.price !== -1); // Exclude rows without SKU or with price -1
}

/**
 * Parse Digital Id sheet data
 * Columns: _timestamp, image, name, price, sku, description, url
 */
function parseDigitalIdSheet(rows, includeDescription = false) {
  if (rows.length < 2) return [];

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Find column indices
  const priceIdx = headers.findIndex(h => h.toLowerCase() === 'price');
  const skuIdx = headers.findIndex(h => h.toLowerCase() === 'sku');
  const descIdx = headers.findIndex(h => h.toLowerCase() === 'description');
  const nameIdx = headers.findIndex(h => h.toLowerCase() === 'name');

  return dataRows.map(row => {
    // Strip currency symbol and parse price
    const priceStr = (row[priceIdx] || '').replace(/[£$€,]/g, '').trim();
    const result = {
      sku: row[skuIdx] || '',
      price: parseFloat(priceStr) || null
    };
    if (includeDescription) {
      result.name = row[nameIdx] || '';
      result.description = row[descIdx] || '';
    }
    return result;
  }).filter(item => item.sku && item.price !== -1); // Exclude rows without SKU or with price -1
}

/**
 * Parse Description sheet data (product uses)
 * Columns: _timestamp, Product ID, SKU, Description
 */
function parseDescriptionSheet(rows) {
  if (rows.length < 2) return [];

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Find column indices
  const skuIdx = headers.findIndex(h => h.toLowerCase() === 'sku');
  const descIdx = headers.findIndex(h => h.toLowerCase() === 'description');

  return dataRows.map(row => ({
    sku: row[skuIdx] || '',
    productUses: row[descIdx] || ''
  })).filter(item => item.sku);
}

/**
 * Combine data from all sheets, matching by SKU (deduplicated)
 */
function combineData(tradeIdData, digitalIdData) {
  // Create a map for Digital Id prices by SKU (keep first occurrence only)
  const digitalIdMap = new Map();
  digitalIdData.forEach(item => {
    if (!digitalIdMap.has(item.sku)) {
      digitalIdMap.set(item.sku, item.price);
    }
  });

  // Deduplicate trade-id data by SKU (keep first occurrence)
  const seenSkus = new Set();
  const dedupedTradeId = tradeIdData.filter(item => {
    if (seenSkus.has(item.sku)) {
      return false;
    }
    seenSkus.add(item.sku);
    return true;
  });

  // Combine with trade-id as the base, filtering out items without matching prices
  return dedupedTradeId
    .map(item => ({
      sku: item.sku,
      productId: item.productId,
      set1: {
        name: item.name,
        cost: item.price,
        stock: item.stock
      },
      set2: {
        cost: digitalIdMap.get(item.sku) || null
      }
    }))
    .filter(item => item.set1.cost !== null && item.set2.cost !== null);
}

// HTTP Basic Auth credentials
const BASIC_AUTH_USER = 'admin';
const BASIC_AUTH_PASS = '1q2w3e4r';

function checkBasicAuth(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  const base64Credentials = authHeader.slice(6);
  const credentials = atob(base64Credentials);
  const [username, password] = credentials.split(':');
  return username === BASIC_AUTH_USER && password === BASIC_AUTH_PASS;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Check Basic Auth for all requests
    if (!checkBasicAuth(request)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Product Dashboard"',
          ...corsHeaders
        }
      });
    }

    // Debug logs endpoint - POST to store logs from client (using Cache API for persistence)
    if (url.pathname === '/api/debug/client-logs' && request.method === 'POST') {
      try {
        const body = await request.json();
        const debugData = {
          logs: body.logs || [],
          settings: body.settings || {},
          lastUpdated: new Date().toISOString()
        };

        // Store in cache (persists across worker restarts for ~1 hour)
        const cache = caches.default;
        const cacheResponse = new Response(JSON.stringify(debugData), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' }
        });
        await cache.put(DEBUG_CACHE_KEY, cacheResponse);

        return new Response(JSON.stringify({ success: true, received: debugData.logs.length }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Debug logs endpoint - GET to retrieve logs (for Claude to fetch)
    if (url.pathname === '/api/debug/client-logs' && request.method === 'GET') {
      try {
        const cache = caches.default;
        const cachedResponse = await cache.match(DEBUG_CACHE_KEY);

        if (cachedResponse) {
          const debugData = await cachedResponse.json();
          return new Response(JSON.stringify(debugData, null, 2), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({ logs: [], settings: {}, lastUpdated: null }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Zoho Inventory: Get access token
    async function getZohoAccessToken(env) {
      const response = await fetch('https://accounts.zoho.eu/oauth/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: env.ZOHO_CLIENT_ID,
          client_secret: env.ZOHO_CLIENT_SECRET,
          refresh_token: env.ZOHO_REFRESH_TOKEN
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      return data.access_token;
    }

    // Zoho Inventory: Search item by SKU
    async function zohoSearchItemBySku(accessToken, orgId, sku) {
      const response = await fetch(
        `https://www.zohoapis.eu/inventory/v1/items?organization_id=${orgId}&sku=${encodeURIComponent(sku)}`,
        {
          headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
        }
      );
      const data = await response.json();
      if (data.code !== 0) throw new Error(data.message || 'Failed to search item');
      return data.items && data.items.length > 0 ? data.items[0] : null;
    }

    // Zoho Inventory: Update item prices
    async function zohoUpdateItemPrices(accessToken, orgId, itemId, costPrice, sellingPrice) {
      const response = await fetch(
        `https://www.zohoapis.eu/inventory/v1/items/${itemId}?organization_id=${orgId}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            purchase_rate: costPrice,
            rate: sellingPrice
          })
        }
      );
      const data = await response.json();
      if (data.code !== 0) throw new Error(data.message || 'Failed to update item');
      return data.item;
    }

    // API endpoint to push prices to Zoho Inventory
    if (url.pathname === '/api/zoho/update' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { sku, costPrice, sellingPrice } = body;

        if (!sku) {
          return new Response(JSON.stringify({ error: 'SKU is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Get access token
        const accessToken = await getZohoAccessToken(env);

        // Find item by SKU
        const item = await zohoSearchItemBySku(accessToken, env.ZOHO_ORG_ID, sku);
        if (!item) {
          return new Response(JSON.stringify({ error: `Item not found with SKU: ${sku}` }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Update prices
        const updatedItem = await zohoUpdateItemPrices(
          accessToken,
          env.ZOHO_ORG_ID,
          item.item_id,
          costPrice,
          sellingPrice
        );

        return new Response(JSON.stringify({
          success: true,
          sku,
          itemId: item.item_id,
          itemName: updatedItem.name,
          costPrice,
          sellingPrice
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // API endpoint to batch update prices to Zoho Inventory
    if (url.pathname === '/api/zoho/batch-update' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { items } = body; // Array of { sku, costPrice, sellingPrice }

        if (!items || !Array.isArray(items) || items.length === 0) {
          return new Response(JSON.stringify({ error: 'Items array is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const accessToken = await getZohoAccessToken(env);
        const results = [];

        for (const item of items) {
          try {
            const zohoItem = await zohoSearchItemBySku(accessToken, env.ZOHO_ORG_ID, item.sku);
            if (!zohoItem) {
              results.push({ sku: item.sku, success: false, error: 'Item not found' });
              continue;
            }

            await zohoUpdateItemPrices(
              accessToken,
              env.ZOHO_ORG_ID,
              zohoItem.item_id,
              item.costPrice,
              item.sellingPrice
            );

            results.push({ sku: item.sku, success: true });
          } catch (err) {
            results.push({ sku: item.sku, success: false, error: err.message });
          }
        }

        return new Response(JSON.stringify({ results }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Exchange rate endpoint (EUR to GBP)
    if (url.pathname === '/api/exchange-rate') {
      try {
        const response = await fetch('https://data.ecb.europa.eu/data-detail-api/EXR.D.GBP.EUR.SP00.A');
        if (!response.ok) throw new Error('Failed to fetch exchange rate');
        const data = await response.json();
        const latest = data.find(d => d.OBS !== null);
        return new Response(JSON.stringify({
          rate: parseFloat(latest.OBS),
          date: latest.PERIOD,
          pair: 'EUR/GBP'
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Debug endpoint to list all sheets
    if (url.pathname === '/api/debug/sheets') {
      try {
        const serviceAccountJson = atob(env.GOOGLE_SERVICE_ACCOUNT_B64);
        const serviceAccount = JSON.parse(serviceAccountJson);
        const accessToken = await getAccessToken(serviceAccount);
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties.title`;
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await response.json();
        return new Response(JSON.stringify(data, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Debug endpoint to see raw Digital ID data
    if (url.pathname === '/api/debug/digitalid') {
      try {
        const serviceAccountJson = atob(env.GOOGLE_SERVICE_ACCOUNT_B64);
        const serviceAccount = JSON.parse(serviceAccountJson);
        const accessToken = await getAccessToken(serviceAccount);
        const rows = await fetchSheet(accessToken, SHEETS.digitalId);
        return new Response(JSON.stringify({ headers: rows[0], sampleRows: rows.slice(1, 6) }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Debug endpoint to see raw Description sheet data
    if (url.pathname === '/api/debug/description') {
      try {
        const serviceAccountJson = atob(env.GOOGLE_SERVICE_ACCOUNT_B64);
        const serviceAccount = JSON.parse(serviceAccountJson);
        const accessToken = await getAccessToken(serviceAccount);
        const rows = await fetchSheet(accessToken, SHEETS.description);
        return new Response(JSON.stringify({ headers: rows[0], sampleRows: rows.slice(1, 6) }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Debug endpoint to show SKU matching diff
    if (url.pathname === '/api/debug/sku-diff') {
      try {
        const serviceAccountJson = atob(env.GOOGLE_SERVICE_ACCOUNT_B64);
        const serviceAccount = JSON.parse(serviceAccountJson);
        const accessToken = await getAccessToken(serviceAccount);

        const [tradeIdRows, digitalIdRows] = await Promise.all([
          fetchSheet(accessToken, SHEETS.tradeId),
          fetchSheet(accessToken, SHEETS.digitalId)
        ]);

        const tradeIdData = parseTradeIdSheet(tradeIdRows);
        const digitalIdData = parseDigitalIdSheet(digitalIdRows);

        // Dedupe both sets
        const tradeIdSkus = new Set();
        tradeIdData.forEach(item => tradeIdSkus.add(item.sku));

        const digitalIdSkus = new Set();
        digitalIdData.forEach(item => digitalIdSkus.add(item.sku));

        // Find unmatched
        const inDigitalNotTrade = [...digitalIdSkus].filter(sku => !tradeIdSkus.has(sku));
        const inTradeNotDigital = [...tradeIdSkus].filter(sku => !digitalIdSkus.has(sku));

        return new Response(JSON.stringify({
          tradeIdCount: tradeIdSkus.size,
          digitalIdCount: digitalIdSkus.size,
          matchedCount: [...tradeIdSkus].filter(sku => digitalIdSkus.has(sku)).length,
          inDigitalNotTrade: {
            count: inDigitalNotTrade.length,
            skus: inDigitalNotTrade.sort()
          },
          inTradeNotDigital: {
            count: inTradeNotDigital.length,
            skus: inTradeNotDigital.sort()
          }
        }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // API endpoint to get product descriptions
    if (url.pathname === '/api/descriptions') {
      try {
        const serviceAccountJson = atob(env.GOOGLE_SERVICE_ACCOUNT_B64);
        const serviceAccount = JSON.parse(serviceAccountJson);
        const accessToken = await getAccessToken(serviceAccount);

        // Fetch Digital Id (for descriptions) and Description sheet (for product uses) in parallel
        const [digitalIdRows, descriptionRows] = await Promise.all([
          fetchSheet(accessToken, SHEETS.digitalId),
          fetchSheet(accessToken, SHEETS.description)
        ]);

        // Parse with descriptions included
        const digitalIdData = parseDigitalIdSheet(digitalIdRows, true);
        const descriptionData = parseDescriptionSheet(descriptionRows);

        // Create a map of product uses by SKU
        const productUsesMap = new Map();
        descriptionData.forEach(item => {
          if (!productUsesMap.has(item.sku)) {
            productUsesMap.set(item.sku, item.productUses);
          }
        });

        // Combine: use Digital Id as base, add product uses from Description sheet
        const combinedDescriptions = digitalIdData.map(item => ({
          sku: item.sku,
          name: item.name,
          description: item.description,
          productUses: productUsesMap.get(item.sku) || ''
        }));

        return new Response(JSON.stringify(combinedDescriptions), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // API endpoint to get product data
    if (url.pathname === '/api/products') {
      try {
        // Parse service account credentials (base64 encoded)
        const serviceAccountJson = atob(env.GOOGLE_SERVICE_ACCOUNT_B64);
        const serviceAccount = JSON.parse(serviceAccountJson);

        // Get access token
        const accessToken = await getAccessToken(serviceAccount);

        // Fetch both sheets in parallel
        const [tradeIdRows, digitalIdRows] = await Promise.all([
          fetchSheet(accessToken, SHEETS.tradeId),
          fetchSheet(accessToken, SHEETS.digitalId)
        ]);

        // Parse sheet data
        const tradeIdData = parseTradeIdSheet(tradeIdRows);
        const digitalIdData = parseDigitalIdSheet(digitalIdRows);

        // Combine data
        const combinedData = combineData(tradeIdData, digitalIdData);

        return new Response(JSON.stringify(combinedData), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // Shopify OAuth: Start authorization flow
    if (url.pathname === '/api/shopify/auth') {
      const redirectUri = `${url.origin}/api/shopify/callback`;
      const state = crypto.randomUUID();

      const authUrl = new URL(`https://${env.SHOPIFY_STORE}/admin/oauth/authorize`);
      authUrl.searchParams.set('client_id', env.SHOPIFY_CLIENT_ID);
      authUrl.searchParams.set('scope', SHOPIFY_SCOPES);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);

      return Response.redirect(authUrl.toString(), 302);
    }

    // Shopify OAuth: Handle callback
    if (url.pathname === '/api/shopify/callback') {
      const code = url.searchParams.get('code');

      if (!code) {
        return new Response('Missing authorization code', { status: 400 });
      }

      try {
        // Exchange code for access token
        const tokenResponse = await fetch(`https://${env.SHOPIFY_STORE}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.SHOPIFY_CLIENT_ID,
            client_secret: env.SHOPIFY_CLIENT_SECRET,
            code: code
          })
        });

        if (!tokenResponse.ok) {
          const err = await tokenResponse.text();
          throw new Error(`Token exchange failed: ${err}`);
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // Redirect back to dashboard with token in URL hash (client-side only)
        return Response.redirect(`${url.origin}/?shopify_token=${accessToken}#descriptions`, 302);
      } catch (error) {
        return new Response(`OAuth error: ${error.message}`, { status: 500 });
      }
    }

    // Shopify: Sync product description
    if (url.pathname === '/api/shopify/sync' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { accessToken, sku, description, htmlTitle, metaDescription } = body;

        if (!accessToken) {
          return new Response(JSON.stringify({ error: 'Missing access token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (!sku) {
          return new Response(JSON.stringify({ error: 'Missing SKU' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const shopifyHeaders = {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        };

        // Step 1: Find product by SKU using GraphQL
        const searchQuery = `
          query {
            products(first: 1, query: "sku:${sku}") {
              edges {
                node {
                  id
                  title
                  descriptionHtml
                  seo {
                    title
                    description
                  }
                }
              }
            }
          }
        `;

        const searchResponse = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({ query: searchQuery })
        });

        if (!searchResponse.ok) {
          const err = await searchResponse.text();
          throw new Error(`Shopify search failed: ${err}`);
        }

        const searchData = await searchResponse.json();

        if (searchData.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(searchData.errors)}`);
        }

        const products = searchData.data?.products?.edges || [];
        if (products.length === 0) {
          return new Response(JSON.stringify({ error: `Product not found with SKU: ${sku}` }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const productId = products[0].node.id;
        const productTitle = products[0].node.title;

        // Step 2: Update product description and SEO
        const updateMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                title
                descriptionHtml
                seo {
                  title
                  description
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const updateInput = {
          id: productId,
          descriptionHtml: description || undefined,
          seo: {
            title: htmlTitle || undefined,
            description: metaDescription || undefined
          }
        };

        // Add metafield for description_tag (used by some themes for <meta name="description">)
        if (metaDescription) {
          updateInput.metafields = [
            {
              namespace: "global",
              key: "description_tag",
              value: metaDescription,
              type: "single_line_text_field"
            }
          ];
        }

        // Remove undefined values
        if (!updateInput.descriptionHtml) delete updateInput.descriptionHtml;
        if (!updateInput.seo.title && !updateInput.seo.description) {
          delete updateInput.seo;
        } else {
          if (!updateInput.seo.title) delete updateInput.seo.title;
          if (!updateInput.seo.description) delete updateInput.seo.description;
        }

        const updateResponse = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({
            query: updateMutation,
            variables: { input: updateInput }
          })
        });

        if (!updateResponse.ok) {
          const err = await updateResponse.text();
          throw new Error(`Shopify update failed: ${err}`);
        }

        const updateData = await updateResponse.json();

        if (updateData.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(updateData.errors)}`);
        }

        const userErrors = updateData.data?.productUpdate?.userErrors || [];
        if (userErrors.length > 0) {
          throw new Error(`Update error: ${userErrors.map(e => e.message).join(', ')}`);
        }

        // Get updated product data to confirm
        const updatedProduct = updateData.data?.productUpdate?.product;

        return new Response(JSON.stringify({
          success: true,
          sku,
          productId,
          productTitle,
          debug: {
            sentSeo: updateInput.seo || null,
            receivedSeo: updatedProduct?.seo || null,
            hadHtmlTitle: !!htmlTitle,
            hadMetaDesc: !!metaDescription
          }
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Shopify: Get stock levels for all products
    if (url.pathname === '/api/shopify/stock' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { accessToken } = body;

        if (!accessToken) {
          return new Response(JSON.stringify({ error: 'Missing access token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const shopifyHeaders = {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        };

        // Fetch products with inventory info and status using GraphQL
        const stockQuery = `
          query {
            products(first: 250) {
              edges {
                node {
                  id
                  status
                  variants(first: 10) {
                    edges {
                      node {
                        sku
                        inventoryQuantity
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const response = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({ query: stockQuery })
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Shopify stock fetch failed: ${err}`);
        }

        const data = await response.json();

        if (data.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
        }

        // Build SKU -> stock map and SKU -> status map
        const stock = {};
        const status = {};
        const productIds = {};
        const products = data.data?.products?.edges || [];
        for (const product of products) {
          const productStatus = product.node?.status;
          const productId = product.node?.id;
          const variants = product.node?.variants?.edges || [];
          for (const variant of variants) {
            const sku = variant.node?.sku;
            const qty = variant.node?.inventoryQuantity;
            if (sku) {
              if (qty !== null) {
                stock[sku] = qty;
              }
              if (productStatus) {
                status[sku] = productStatus;
              }
              if (productId) {
                productIds[sku] = productId;
              }
            }
          }
        }

        return new Response(JSON.stringify({ stock, status, productIds }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Shopify: Update stock level for a product variant by SKU
    if (url.pathname === '/api/shopify/update-stock' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { accessToken, sku, quantity } = body;

        if (!accessToken) {
          return new Response(JSON.stringify({ error: 'Missing access token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (!sku || quantity === undefined) {
          return new Response(JSON.stringify({ error: 'Missing SKU or quantity' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const shopifyHeaders = {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        };

        // Step 1: Find product variant by SKU and get inventory_item_id
        const findVariantQuery = `
          query {
            productVariants(first: 1, query: "sku:${sku}") {
              edges {
                node {
                  id
                  sku
                  inventoryItem {
                    id
                    inventoryLevels(first: 1) {
                      edges {
                        node {
                          id
                          location {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const variantResponse = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({ query: findVariantQuery })
        });

        if (!variantResponse.ok) {
          const err = await variantResponse.text();
          throw new Error(`Shopify variant lookup failed: ${err}`);
        }

        const variantData = await variantResponse.json();

        if (variantData.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(variantData.errors)}`);
        }

        const variants = variantData.data?.productVariants?.edges || [];
        if (variants.length === 0) {
          return new Response(JSON.stringify({ error: `Variant not found with SKU: ${sku}` }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const variant = variants[0].node;
        const inventoryItemId = variant.inventoryItem?.id;
        const inventoryLevels = variant.inventoryItem?.inventoryLevels?.edges || [];

        if (!inventoryItemId || inventoryLevels.length === 0) {
          return new Response(JSON.stringify({ error: `No inventory tracking for SKU: ${sku}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const locationId = inventoryLevels[0].node.location.id;

        // Step 2: Set the inventory quantity using inventorySetOnHandQuantities
        const setQuantityMutation = `
          mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
            inventorySetOnHandQuantities(input: $input) {
              inventoryAdjustmentGroup {
                createdAt
                reason
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const setQuantityResponse = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({
            query: setQuantityMutation,
            variables: {
              input: {
                reason: "correction",
                setQuantities: [{
                  inventoryItemId: inventoryItemId,
                  locationId: locationId,
                  quantity: parseInt(quantity)
                }]
              }
            }
          })
        });

        if (!setQuantityResponse.ok) {
          const err = await setQuantityResponse.text();
          throw new Error(`Shopify inventory update failed: ${err}`);
        }

        const setQuantityData = await setQuantityResponse.json();

        if (setQuantityData.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(setQuantityData.errors)}`);
        }

        const userErrors = setQuantityData.data?.inventorySetOnHandQuantities?.userErrors || [];
        if (userErrors.length > 0) {
          throw new Error(`Inventory update error: ${userErrors.map(e => e.message).join(', ')}`);
        }

        return new Response(JSON.stringify({
          success: true,
          sku,
          quantity: parseInt(quantity),
          inventoryItemId,
          locationId
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Shopify: Update product status by product ID
    if (url.pathname === '/api/shopify/update-status' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { accessToken, productId, status } = body;

        if (!accessToken) {
          return new Response(JSON.stringify({ error: 'Missing access token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (!productId || !status) {
          return new Response(JSON.stringify({ error: 'Missing productId or status' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const validStatuses = ['ACTIVE', 'DRAFT', 'ARCHIVED'];
        if (!validStatuses.includes(status)) {
          return new Response(JSON.stringify({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const shopifyHeaders = {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        };

        const updateStatusMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                status
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const response = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({
            query: updateStatusMutation,
            variables: {
              input: {
                id: productId,
                status: status
              }
            }
          })
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Shopify status update failed: ${err}`);
        }

        const data = await response.json();

        if (data.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
        }

        const userErrors = data.data?.productUpdate?.userErrors || [];
        if (userErrors.length > 0) {
          throw new Error(`Status update error: ${userErrors.map(e => e.message).join(', ')}`);
        }

        const updatedProduct = data.data?.productUpdate?.product;

        return new Response(JSON.stringify({
          success: true,
          productId,
          status: updatedProduct?.status
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Zoho Inventory: Get stock levels for all items
    if (url.pathname === '/api/zoho/stock' && request.method === 'GET') {
      try {
        const accessToken = await getZohoAccessToken(env);

        // Fetch all items with stock info
        const response = await fetch(
          `https://www.zohoapis.eu/inventory/v1/items?organization_id=${env.ZOHO_ORG_ID}&per_page=200`,
          {
            headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
          }
        );

        const data = await response.json();
        if (data.code !== 0) throw new Error(data.message || 'Failed to fetch items');

        // Build SKU -> stock map
        const stock = {};
        const items = data.items || [];
        for (const item of items) {
          if (item.sku && item.stock_on_hand !== undefined) {
            stock[item.sku] = item.stock_on_hand;
          }
        }

        return new Response(JSON.stringify({ stock }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Serve static assets for all other routes
    try {
      const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
      return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  }
};
