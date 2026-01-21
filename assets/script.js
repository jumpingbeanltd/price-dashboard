// --- STATE ---
let productData = [];
let filteredData = [];
let currentSort = { key: 'sku', direction: 'asc' };
let currentPage = 1;
const PAGE_SIZE = 50;
let lastClickedIndex = null;
let exchangeRate = null;
let identitySelections = {};
let identityOverrides = {}; // Manual price overrides
let roundingValue = 0;
let zohoUpdateTimestamps = {}; // SKU -> last update timestamp
let shopifyStockData = {}; // SKU -> stock level
let zohoStockData = {}; // SKU -> stock level
let zohoStockOverrides = {}; // SKU -> manual override
let shopifyStockOverrides = {}; // SKU -> manual override
let shopifyStatusData = {}; // SKU -> status (ACTIVE, DRAFT, ARCHIVED)
let shopifyProductIds = {}; // SKU -> Shopify product GID

// --- LOGGING ---
const LOG_STORAGE_KEY = 'price_dashboard_logs';
const ZOHO_TIMESTAMPS_KEY = 'price_dashboard_zoho_timestamps';
const MAX_LOG_ENTRIES = 1000;

function saveLog(entries) {
    const logs = getLogs();
    const timestamp = new Date().toISOString();

    entries.forEach(entry => {
        logs.unshift({
            timestamp,
            ...entry
        });
    });

    // Keep only the latest MAX_LOG_ENTRIES
    const trimmedLogs = logs.slice(0, MAX_LOG_ENTRIES);
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(trimmedLogs));
}

function getLogs() {
    try {
        const stored = localStorage.getItem(LOG_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

function saveZohoTimestamps() {
    localStorage.setItem(ZOHO_TIMESTAMPS_KEY, JSON.stringify(zohoUpdateTimestamps));
}

function loadZohoTimestamps() {
    try {
        const stored = localStorage.getItem(ZOHO_TIMESTAMPS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

function formatTimestamp(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// --- DOM ELEMENTS ---
const tableBody = document.getElementById('product-table-body');
const checkAllBox = document.getElementById('check-all');
const loadingEl = document.getElementById('loading');
const statsEl = document.getElementById('stats');
const pageInfoEl = document.getElementById('page-info');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const filterSkuEl = document.getElementById('filter-sku');
const filterNameEl = document.getElementById('filter-name');
const exchangeRateEl = document.getElementById('exchange-rate-text');
const identityFillAllEl = document.getElementById('identity-fill-all');
const roundingSelectEl = document.getElementById('rounding-select');
const pushSelectedZohoBtn = document.getElementById('push-selected-zoho');
const matchStockBtn = document.getElementById('match-stock-btn');
const zohoStatusEl = document.getElementById('zoho-status');

// Pastel colors for alternating rows
const pastelColors = [
    'bg-rose-50/50',
    'bg-amber-50/50',
    'bg-lime-50/50',
    'bg-cyan-50/50',
    'bg-violet-50/50'
];

// --- API ---
async function fetchProductData() {
    try {
        const response = await fetch('/api/products');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data;
    } catch (error) {
        console.error('Failed to fetch product data:', error);
        loadingEl.textContent = 'Failed to load data: ' + error.message;
        return [];
    }
}

async function fetchExchangeRate() {
    try {
        const response = await fetch('/api/exchange-rate');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data;
    } catch (error) {
        console.error('Failed to fetch exchange rate:', error);
        return null;
    }
}

async function fetchShopifyStock() {
    const token = localStorage.getItem('price_dashboard_shopify_token');
    if (!token) {
        return { stock: {}, status: {}, productIds: {} };
    }
    try {
        const response = await fetch('/api/shopify/stock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: token })
        });
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return {
            stock: data.stock || {},
            status: data.status || {},
            productIds: data.productIds || {}
        };
    } catch (error) {
        console.error('Failed to fetch Shopify stock:', error);
        return { stock: {}, status: {}, productIds: {} };
    }
}

async function fetchZohoStock() {
    try {
        const response = await fetch('/api/zoho/stock');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data.stock || {};
    } catch (error) {
        console.error('Failed to fetch Zoho stock:', error);
        return {};
    }
}

// --- FUNCTIONS ---
function roundToNearest(value, nearest) {
    if (!nearest || nearest === 0) return value;
    return Math.round(value / nearest) * nearest;
}

function formatPrice(price) {
    if (price === null || price === undefined || isNaN(price)) return '—';
    return `£${price.toFixed(2)}`;
}

function formatPriceEur(price) {
    if (price === null || price === undefined || isNaN(price)) return '—';
    return `€${price.toFixed(2)}`;
}

function formatStock(stock) {
    if (stock === null || stock === undefined) return '—';
    return stock.toLocaleString();
}

function formatDiff(diff) {
    if (diff === null || diff === undefined || isNaN(diff)) return '—';
    const sign = diff >= 0 ? '+' : '';
    return `${sign}£${diff.toFixed(2)}`;
}

function formatMarkup(markup) {
    if (markup === null || markup === undefined || isNaN(markup)) return '—';
    const sign = markup >= 0 ? '+' : '';
    return `${sign}${markup.toFixed(1)}%`;
}

function calculateDiff(product) {
    const tradeId = product.set1?.cost;
    const digitalId = product.set2?.cost;
    if (tradeId == null || digitalId == null) return null;
    return digitalId - tradeId;
}

function calculateMarkup(product) {
    const tradeId = product.set1?.cost;
    const digitalId = product.set2?.cost;
    if (tradeId == null || digitalId == null || tradeId === 0) return null;
    return ((digitalId - tradeId) / tradeId) * 100;
}

function gbpToEur(gbpAmount) {
    if (gbpAmount == null || !exchangeRate) return null;
    return gbpAmount / exchangeRate;
}

function calculateProfit(product, sellingPrice) {
    if (sellingPrice == null) return null;
    const costGbp = product.set1?.cost;
    if (costGbp == null) return null;
    const costEur = gbpToEur(costGbp);
    if (costEur == null) return null;
    return sellingPrice - costEur;
}

function formatProfit(profit) {
    if (profit === null || profit === undefined || isNaN(profit)) return '—';
    const sign = profit >= 0 ? '+' : '';
    return `${sign}€${profit.toFixed(2)}`;
}

function calculateIdentityPrice(product, selection) {
    if (!selection) return null;

    const digitalIdGbp = product.set2?.cost;
    if (digitalIdGbp == null) return null;

    let price = null;

    if (selection === 'digitalId') {
        price = gbpToEur(digitalIdGbp);
    } else {
        const markupMatch = selection.match(/^\+(\d+)$/);
        if (markupMatch) {
            const markupPercent = parseInt(markupMatch[1]);
            const eurPrice = gbpToEur(digitalIdGbp);
            if (eurPrice == null) return null;
            price = eurPrice * (1 + markupPercent / 100);
        }
    }

    if (price !== null && roundingValue > 0) {
        price = roundToNearest(price, roundingValue);
    }

    return price;
}

function getIdentityPrice(sku, product) {
    // Check for manual override first
    if (identityOverrides[sku] !== undefined) {
        return identityOverrides[sku];
    }
    // Otherwise calculate from selection
    const selection = identitySelections[sku] || '';
    return calculateIdentityPrice(product, selection);
}

function getSortValue(product, key) {
    switch (key) {
        case 'sku': return product.sku || '';
        case 'stock': return product.set1?.stock ?? -1;
        case 'shopifyStock': return shopifyStockData[product.sku] ?? -1;
        case 'zohoStock': return zohoStockData[product.sku] ?? -1;
        case 'shopifyStatus': return shopifyStatusData[product.sku] || '';
        case 'name': return product.set1?.name || '';
        case 'tradeId': return product.set1?.cost ?? -1;
        case 'digitalId': return product.set2?.cost ?? -1;
        case 'diff': return calculateDiff(product) ?? -9999;
        case 'markup': return calculateMarkup(product) ?? -9999;
        default: return '';
    }
}

function applyFilters() {
    const skuFilter = filterSkuEl.value.toLowerCase().trim();
    const nameFilter = filterNameEl.value.toLowerCase().trim();

    filteredData = productData.filter(p => {
        const skuMatch = !skuFilter || (p.sku || '').toLowerCase().includes(skuFilter);
        const nameMatch = !nameFilter || (p.set1?.name || '').toLowerCase().includes(nameFilter);
        return skuMatch && nameMatch;
    });

    currentPage = 1;
    sortData();
}

function sortData() {
    filteredData.sort((a, b) => {
        const aVal = getSortValue(a, currentSort.key);
        const bVal = getSortValue(b, currentSort.key);

        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
        }

        if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;
        return 0;
    });

    renderTable();
}

function createStatusDropdown(sku, currentStatus) {
    const statusColors = {
        'ACTIVE': 'bg-green-100 text-green-800',
        'DRAFT': 'bg-blue-100 text-blue-800',
        'ARCHIVED': 'bg-gray-100 text-gray-600'
    };
    const colorClass = statusColors[currentStatus] || 'bg-white';

    return `<select class="status-select w-full px-1 py-0.5 text-xs rounded border border-gray-300 ${colorClass}" data-sku="${sku}">
        <option value="" ${!currentStatus ? 'selected' : ''}>—</option>
        <option value="ACTIVE" ${currentStatus === 'ACTIVE' ? 'selected' : ''}>Active</option>
        <option value="DRAFT" ${currentStatus === 'DRAFT' ? 'selected' : ''}>Draft</option>
        <option value="ARCHIVED" ${currentStatus === 'ARCHIVED' ? 'selected' : ''}>Archived</option>
    </select>`;
}

function createIdentityDropdown(sku, currentSelection) {
    const options = [
        { value: '', label: 'Select...' },
        { value: 'digitalId', label: 'Digital ID €' },
        { value: '+10', label: '+10%' },
        { value: '+20', label: '+20%' },
        { value: '+30', label: '+30%' },
        { value: '+40', label: '+40%' },
        { value: '+50', label: '+50%' },
        { value: '+75', label: '+75%' },
        { value: '+100', label: '+100%' },
        { value: '+150', label: '+150%' },
        { value: '+200', label: '+200%' }
    ];

    const optionsHtml = options.map(opt =>
        `<option value="${opt.value}" ${opt.value === currentSelection ? 'selected' : ''}>${opt.label}</option>`
    ).join('');

    return `<select class="identity-select" data-sku="${sku}">${optionsHtml}</select>`;
}

function renderTable() {
    tableBody.innerHTML = '';
    lastClickedIndex = null;

    const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const endIdx = Math.min(startIdx + PAGE_SIZE, filteredData.length);
    const pageData = filteredData.slice(startIdx, endIdx);

    if (pageData.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="14" class="px-2 py-8 text-center text-gray-500">No results found</td></tr>';
        updatePagination(0, 0);
        return;
    }

    pageData.forEach((product, idx) => {
        const row = document.createElement('tr');
        const globalIdx = startIdx + idx;
        row.dataset.sku = product.sku;
        row.dataset.index = globalIdx;

        const pastelColor = pastelColors[idx % pastelColors.length];
        row.className = `${pastelColor} hover:bg-gray-100 transition-colors`;

        const set1Cost = product.set1?.cost;
        const set1Stock = product.set1?.stock;
        const set2Cost = product.set2?.cost;
        const fullName = product.set1?.name || 'Unknown';
        const productName = fullName.length > 24 ? fullName.substring(0, 24) + '...' : fullName;
        const diff = calculateDiff(product);
        const markup = calculateMarkup(product);

        // Identity column
        const identitySelection = identitySelections[product.sku] || '';
        const identityPrice = getIdentityPrice(product.sku, product);
        const hasOverride = identityOverrides[product.sku] !== undefined;
        const priceValue = identityPrice !== null ? identityPrice.toFixed(2) : '';

        // Color coding for diff and markup
        const diffColor = diff === null ? 'text-gray-400' : diff >= 0 ? 'text-green-600' : 'text-red-600';
        const markupColor = markup === null ? 'text-gray-400' : markup >= 0 ? 'text-green-600' : 'text-red-600';

        // Calculate profit
        const profit = calculateProfit(product, identityPrice);
        const profitColor = profit === null ? 'text-gray-400' : profit >= 0 ? 'text-green-600' : 'text-red-600';

        // Get last Zoho update timestamp
        const lastZohoUpdate = zohoUpdateTimestamps[product.sku] || null;

        const shopifyStock = shopifyStockData[product.sku];
        const zohoStock = zohoStockData[product.sku];
        const shopifyStatus = shopifyStatusData[product.sku];

        row.innerHTML = `
            <td class="px-2 py-1.5">
                <input type="checkbox" class="row-check rounded border-gray-300" data-index="${globalIdx}">
            </td>
            <td class="px-2 py-1.5 text-gray-700">${product.sku}</td>
            <td class="px-2 py-1.5 text-gray-600">${formatStock(set1Stock)}</td>
            <td class="px-2 py-1.5">
                <input type="text"
                    class="zoho-stock-input w-14 px-1 py-0.5 text-sm text-gray-600 border border-gray-300 rounded focus:border-blue-500 focus:outline-none ${zohoStockOverrides[product.sku] !== undefined ? 'bg-yellow-100' : 'bg-white'}"
                    data-sku="${product.sku}"
                    value="${zohoStockOverrides[product.sku] !== undefined ? zohoStockOverrides[product.sku] : (zohoStock ?? '')}"
                    placeholder="—"
                    inputmode="numeric">
            </td>
            <td class="px-2 py-1.5">
                <input type="text"
                    class="shopify-stock-input w-14 px-1 py-0.5 text-sm text-gray-600 border border-gray-300 rounded focus:border-blue-500 focus:outline-none ${shopifyStockOverrides[product.sku] !== undefined ? 'bg-yellow-100' : 'bg-white'}"
                    data-sku="${product.sku}"
                    value="${shopifyStockOverrides[product.sku] !== undefined ? shopifyStockOverrides[product.sku] : (shopifyStock ?? '')}"
                    placeholder="—"
                    inputmode="numeric">
            </td>
            <td class="px-2 py-1.5">
                ${createStatusDropdown(product.sku, shopifyStatus)}
            </td>
            <td class="px-2 py-1.5 text-gray-900" title="${fullName}">${productName}</td>
            <td class="px-2 py-1.5 font-medium text-blue-700">${formatPrice(set1Cost)}</td>
            <td class="px-2 py-1.5 font-medium text-green-700">${formatPrice(set2Cost)}</td>
            <td class="px-2 py-1.5 font-medium ${diffColor}">${formatDiff(diff)}</td>
            <td class="px-2 py-1.5 font-medium ${markupColor}">${formatMarkup(markup)}</td>
            <td class="px-2 py-1.5 bg-indigo-50/30">
                <div class="flex items-center gap-1">
                    ${createIdentityDropdown(product.sku, identitySelection)}
                    <div class="flex items-center">
                        <span class="text-indigo-700">€</span>
                        <input type="text"
                            class="identity-input w-16 px-1 py-0.5 text-sm font-medium text-indigo-700 border border-gray-300 rounded focus:border-blue-500 focus:outline-none ${hasOverride ? 'bg-yellow-100' : 'bg-white'}"
                            data-sku="${product.sku}"
                            value="${priceValue}"
                            placeholder="—"
                            inputmode="decimal">
                    </div>
                </div>
            </td>
            <td class="px-2 py-1.5 font-medium ${profitColor} bg-emerald-50/30">${formatProfit(profit)}</td>
            <td class="px-2 py-1.5 text-xs text-gray-500 bg-gray-50/50">${formatTimestamp(lastZohoUpdate)}</td>
        `;
        tableBody.appendChild(row);
    });

    updatePagination(startIdx + 1, endIdx);
    updateSortIndicators();

    // Update stats
    const set2Count = filteredData.filter(p => p.set2?.cost).length;
    statsEl.textContent = `${filteredData.length} products${filteredData.length !== productData.length ? ` (filtered from ${productData.length})` : ''} • ${set2Count} with Digital ID prices`;
}

function updatePagination(start, end) {
    const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);

    if (filteredData.length === 0) {
        pageInfoEl.textContent = 'No results';
    } else {
        pageInfoEl.textContent = `Showing ${start}-${end} of ${filteredData.length}`;
    }

    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
}

function updateSortIndicators() {
    document.querySelectorAll('.sortable').forEach(th => {
        const indicator = th.querySelector('.sort-indicator');
        const key = th.dataset.sort;

        if (key === currentSort.key) {
            indicator.textContent = currentSort.direction === 'asc' ? '↑' : '↓';
            indicator.classList.add('text-blue-600');
        } else {
            indicator.textContent = '↕';
            indicator.classList.remove('text-blue-600');
        }
    });
}

function handleShiftClick(clickedIndex, checked) {
    if (lastClickedIndex === null) {
        lastClickedIndex = clickedIndex;
        return;
    }

    const start = Math.min(lastClickedIndex, clickedIndex);
    const end = Math.max(lastClickedIndex, clickedIndex);

    const checkboxes = tableBody.querySelectorAll('.row-check');
    checkboxes.forEach(cb => {
        const idx = parseInt(cb.dataset.index);
        if (idx >= start && idx <= end) {
            cb.checked = checked;
        }
    });

    lastClickedIndex = clickedIndex;
}

function updateExchangeRateDisplay(data) {
    if (data && data.rate) {
        exchangeRate = data.rate;
        exchangeRateEl.innerHTML = `<span class="font-medium">EUR/GBP:</span> ${data.rate.toFixed(4)} <span class="text-gray-400 text-xs">(${data.date})</span>`;
    } else {
        exchangeRateEl.textContent = 'Exchange rate unavailable';
    }
}

function updateIdentityFromDropdown(sku, selection) {
    identitySelections[sku] = selection;
    // Clear any manual override when dropdown changes
    delete identityOverrides[sku];

    const product = productData.find(p => p.sku === sku);
    if (!product) return;

    const identityPrice = calculateIdentityPrice(product, selection);
    const row = tableBody.querySelector(`tr[data-sku="${sku}"]`);
    if (row) {
        const input = row.querySelector('.identity-input');
        if (input) {
            input.value = identityPrice !== null ? identityPrice.toFixed(2) : '';
            input.classList.remove('bg-yellow-100');
            input.classList.add('bg-white');
        }
    }
}

function updateIdentityFromInput(sku, value) {
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && numValue >= 0) {
        identityOverrides[sku] = numValue;
    } else if (value === '') {
        delete identityOverrides[sku];
    }
}

async function updateShopifyStatus(sku, newStatus, selectElement) {
    const shopifyToken = localStorage.getItem('price_dashboard_shopify_token');
    if (!shopifyToken) {
        zohoStatusEl.textContent = 'Not connected to Shopify';
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    const productId = shopifyProductIds[sku];
    if (!productId) {
        zohoStatusEl.textContent = `No Shopify product ID for ${sku}`;
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    // Disable select during update
    if (selectElement) selectElement.disabled = true;

    try {
        const response = await fetch('/api/shopify/update-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accessToken: shopifyToken,
                productId: productId,
                status: newStatus
            })
        });

        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        // Update local state
        shopifyStatusData[sku] = newStatus;

        // Update dropdown styling
        if (selectElement) {
            selectElement.className = `status-select w-full px-1 py-0.5 text-xs rounded border border-gray-300 ${getStatusColorClass(newStatus)}`;
        }

        zohoStatusEl.textContent = `Status updated: ${sku} → ${newStatus}`;
        zohoStatusEl.className = 'text-sm text-green-600';
    } catch (error) {
        zohoStatusEl.textContent = `Failed: ${error.message}`;
        zohoStatusEl.className = 'text-sm text-red-500';
        // Revert dropdown to previous value
        if (selectElement) {
            selectElement.value = shopifyStatusData[sku] || '';
        }
    } finally {
        if (selectElement) selectElement.disabled = false;
    }
}

function getStatusColorClass(status) {
    const statusColors = {
        'ACTIVE': 'bg-green-100 text-green-800',
        'DRAFT': 'bg-blue-100 text-blue-800',
        'ARCHIVED': 'bg-gray-100 text-gray-600'
    };
    return statusColors[status] || 'bg-white';
}

function fillAllIdentity(selection) {
    productData.forEach(product => {
        identitySelections[product.sku] = selection;
        delete identityOverrides[product.sku];
    });
    renderTable();
    identityFillAllEl.value = '';
}

function recalculateAllIdentityPrices() {
    // Re-render to apply new rounding
    renderTable();
}

// --- EVENT LISTENERS ---
document.addEventListener('DOMContentLoaded', async () => {
    // Load saved timestamps
    zohoUpdateTimestamps = loadZohoTimestamps();

    const [rateData, products] = await Promise.all([
        fetchExchangeRate(),
        fetchProductData()
    ]);

    updateExchangeRateDisplay(rateData);
    productData = products;
    filteredData = [...productData];

    if (productData.length > 0) {
        document.body.classList.add('loaded');
    }
    sortData();

    // Fetch stock levels in background (don't block initial render)
    Promise.all([
        fetchShopifyStock(),
        fetchZohoStock()
    ]).then(([shopifyData, zohoStock]) => {
        shopifyStockData = shopifyData.stock;
        shopifyStatusData = shopifyData.status;
        shopifyProductIds = shopifyData.productIds;
        zohoStockData = zohoStock;
        renderTable(); // Re-render with stock data
    });
});

// Sortable columns
document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (currentSort.key === key) {
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.key = key;
            currentSort.direction = 'asc';
        }
        sortData();
    });
});

// Filters
filterSkuEl.addEventListener('input', applyFilters);
filterNameEl.addEventListener('input', applyFilters);

// Pagination
prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        renderTable();
    }
});

nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
    if (currentPage < totalPages) {
        currentPage++;
        renderTable();
    }
});

// Rounding select
roundingSelectEl.addEventListener('change', (e) => {
    roundingValue = parseFloat(e.target.value) || 0;
    // Clear overrides when rounding changes so recalculated values apply
    identityOverrides = {};
    recalculateAllIdentityPrices();
});

// Fill all identity dropdown
identityFillAllEl.addEventListener('change', (e) => {
    if (e.target.value) {
        fillAllIdentity(e.target.value);
    }
});

// Table event delegation
tableBody.addEventListener('change', (e) => {
    if (e.target.classList.contains('identity-select')) {
        const sku = e.target.dataset.sku;
        updateIdentityFromDropdown(sku, e.target.value);
    }

    if (e.target.classList.contains('status-select')) {
        const sku = e.target.dataset.sku;
        const newStatus = e.target.value;
        if (newStatus) {
            updateShopifyStatus(sku, newStatus, e.target);
        }
    }
});

tableBody.addEventListener('input', (e) => {
    if (e.target.classList.contains('identity-input')) {
        // Sanitize to numbers only (allow digits and one decimal point)
        let value = e.target.value.replace(/[^0-9.]/g, '');
        // Ensure only one decimal point
        const parts = value.split('.');
        if (parts.length > 2) {
            value = parts[0] + '.' + parts.slice(1).join('');
        }
        e.target.value = value;

        const sku = e.target.dataset.sku;
        updateIdentityFromInput(sku, value);
        // Mark as override with yellow background
        if (value !== '') {
            e.target.classList.remove('bg-white');
            e.target.classList.add('bg-yellow-100');
        } else {
            e.target.classList.remove('bg-yellow-100');
            e.target.classList.add('bg-white');
        }
    }

    if (e.target.classList.contains('zoho-stock-input')) {
        // Sanitize to integers only
        let value = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = value;

        const sku = e.target.dataset.sku;
        if (value !== '') {
            zohoStockOverrides[sku] = parseInt(value);
            e.target.classList.remove('bg-white');
            e.target.classList.add('bg-yellow-100');
        } else {
            delete zohoStockOverrides[sku];
            e.target.classList.remove('bg-yellow-100');
            e.target.classList.add('bg-white');
        }
    }

    if (e.target.classList.contains('shopify-stock-input')) {
        // Sanitize to integers only
        let value = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = value;

        const sku = e.target.dataset.sku;
        if (value !== '') {
            shopifyStockOverrides[sku] = parseInt(value);
            e.target.classList.remove('bg-white');
            e.target.classList.add('bg-yellow-100');
        } else {
            delete shopifyStockOverrides[sku];
            e.target.classList.remove('bg-yellow-100');
            e.target.classList.add('bg-white');
        }
    }
});

// Row selection with shift-click
tableBody.addEventListener('click', (e) => {
    const checkbox = e.target.closest('.row-check');
    if (!checkbox) return;

    const index = parseInt(checkbox.dataset.index);

    if (e.shiftKey && lastClickedIndex !== null) {
        handleShiftClick(index, checkbox.checked);
    } else {
        lastClickedIndex = index;
    }

    const allCheckboxes = tableBody.querySelectorAll('.row-check');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    const someChecked = Array.from(allCheckboxes).some(cb => cb.checked);
    checkAllBox.checked = allChecked;
    checkAllBox.indeterminate = someChecked && !allChecked;
});

// Check all
checkAllBox.addEventListener('change', () => {
    const allCheckboxes = tableBody.querySelectorAll('.row-check');
    allCheckboxes.forEach(box => box.checked = checkAllBox.checked);
});

// Push selected to Zoho
pushSelectedZohoBtn.addEventListener('click', async () => {
    const checkedBoxes = tableBody.querySelectorAll('.row-check:checked');
    if (checkedBoxes.length === 0) {
        zohoStatusEl.textContent = 'No items selected';
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    // Gather selected items with their identity prices
    const itemsToUpdate = [];
    checkedBoxes.forEach(checkbox => {
        const row = checkbox.closest('tr');
        const sku = row.dataset.sku;
        const product = productData.find(p => p.sku === sku);
        if (!product) return;

        const identityPrice = getIdentityPrice(sku, product);
        const costPriceGbp = product.set1?.cost; // Trade ID price in GBP
        const costPriceEur = gbpToEur(costPriceGbp); // Convert to EUR

        if (identityPrice !== null && costPriceEur !== null) {
            itemsToUpdate.push({
                sku,
                costPrice: parseFloat(costPriceEur.toFixed(2)),
                sellingPrice: identityPrice
            });
        }
    });

    if (itemsToUpdate.length === 0) {
        zohoStatusEl.textContent = 'No items with valid prices';
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    // Disable button and show progress
    pushSelectedZohoBtn.disabled = true;
    zohoStatusEl.textContent = `Updating ${itemsToUpdate.length} items...`;
    zohoStatusEl.className = 'text-sm text-blue-500';

    try {
        const response = await fetch('/api/zoho/batch-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: itemsToUpdate })
        });

        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        const successful = data.results.filter(r => r.success).length;
        const failed = data.results.filter(r => !r.success).length;
        const timestamp = new Date().toISOString();

        // Log all changes and update timestamps for successful items
        const logEntries = data.results.map(result => {
            const item = itemsToUpdate.find(i => i.sku === result.sku);
            if (result.success) {
                zohoUpdateTimestamps[result.sku] = timestamp;
            }
            return {
                sku: result.sku,
                costPrice: item?.costPrice,
                sellingPrice: item?.sellingPrice,
                success: result.success,
                error: result.error || null
            };
        });
        saveLog(logEntries);
        saveZohoTimestamps();
        renderTable(); // Re-render to show updated timestamps

        if (failed === 0) {
            zohoStatusEl.textContent = `Updated ${successful} items successfully`;
            zohoStatusEl.className = 'text-sm text-green-600';
        } else {
            zohoStatusEl.textContent = `Updated ${successful}, failed ${failed}`;
            zohoStatusEl.className = 'text-sm text-orange-500';
            console.log('Failed items:', data.results.filter(r => !r.success));
        }
    } catch (error) {
        zohoStatusEl.textContent = `Error: ${error.message}`;
        zohoStatusEl.className = 'text-sm text-red-500';
    } finally {
        pushSelectedZohoBtn.disabled = false;
    }
});

// Match Stock to Shopify (copy Zoho stock → Shopify)
if (matchStockBtn) {
    matchStockBtn.addEventListener('click', async () => {
        console.log('Match Stock button clicked');
    const checkedBoxes = tableBody.querySelectorAll('.row-check:checked');
    if (checkedBoxes.length === 0) {
        zohoStatusEl.textContent = 'No items selected';
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    // Check for Shopify token
    const shopifyToken = localStorage.getItem('price_dashboard_shopify_token');
    if (!shopifyToken) {
        zohoStatusEl.textContent = 'Not connected to Shopify - go to Descriptions tab to connect';
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    // Gather selected items with Zoho stock (use override if available)
    const itemsToUpdate = [];
    checkedBoxes.forEach(checkbox => {
        const row = checkbox.closest('tr');
        const sku = row.dataset.sku;
        // Use override if set, otherwise use fetched Zoho stock
        const quantity = zohoStockOverrides[sku] !== undefined
            ? zohoStockOverrides[sku]
            : zohoStockData[sku];

        if (quantity !== undefined && quantity !== null) {
            itemsToUpdate.push({ sku, quantity });
        }
    });

    if (itemsToUpdate.length === 0) {
        zohoStatusEl.textContent = 'No items with Zoho stock data';
        zohoStatusEl.className = 'text-sm text-orange-500';
        return;
    }

    // Disable button and show progress
    matchStockBtn.disabled = true;
    zohoStatusEl.textContent = `Updating ${itemsToUpdate.length} items in Shopify...`;
    zohoStatusEl.className = 'text-sm text-blue-500';

    let success = 0;
    let failed = 0;
    const errors = [];

    for (const item of itemsToUpdate) {
        try {
            zohoStatusEl.textContent = `Updating ${success + failed + 1}/${itemsToUpdate.length}...`;

            const response = await fetch('/api/shopify/update-stock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessToken: shopifyToken,
                    sku: item.sku,
                    quantity: item.quantity
                })
            });

            const data = await response.json();

            if (data.error) {
                throw new Error(data.error);
            }

            // Update local Shopify stock data
            shopifyStockData[item.sku] = item.quantity;
            success++;
        } catch (error) {
            failed++;
            errors.push({ sku: item.sku, error: error.message });
        }
    }

    // Re-render table to show updated stock
    renderTable();

    // Show results
    if (failed === 0) {
        zohoStatusEl.textContent = `Updated ${success} items in Shopify`;
        zohoStatusEl.className = 'text-sm text-green-600';
    } else {
        zohoStatusEl.textContent = `Updated ${success}, failed ${failed}`;
        zohoStatusEl.className = 'text-sm text-orange-500';
    }

    matchStockBtn.disabled = false;
});
} else {
    console.error('matchStockBtn not found in DOM');
}

// Batch status selector
const batchStatusSelect = document.getElementById('batch-status-select');
if (batchStatusSelect) {
    batchStatusSelect.addEventListener('change', async (e) => {
        const newStatus = e.target.value;
        if (!newStatus) return;

        const checkedBoxes = tableBody.querySelectorAll('.row-check:checked');
        if (checkedBoxes.length === 0) {
            zohoStatusEl.textContent = 'No items selected';
            zohoStatusEl.className = 'text-sm text-orange-500';
            batchStatusSelect.value = '';
            return;
        }

        const shopifyToken = localStorage.getItem('price_dashboard_shopify_token');
        if (!shopifyToken) {
            zohoStatusEl.textContent = 'Not connected to Shopify';
            zohoStatusEl.className = 'text-sm text-orange-500';
            batchStatusSelect.value = '';
            return;
        }

        // Gather SKUs with product IDs
        const itemsToUpdate = [];
        checkedBoxes.forEach(checkbox => {
            const row = checkbox.closest('tr');
            const sku = row.dataset.sku;
            const productId = shopifyProductIds[sku];
            if (productId) {
                itemsToUpdate.push({ sku, productId });
            }
        });

        if (itemsToUpdate.length === 0) {
            zohoStatusEl.textContent = 'No items with Shopify product IDs';
            zohoStatusEl.className = 'text-sm text-orange-500';
            batchStatusSelect.value = '';
            return;
        }

        batchStatusSelect.disabled = true;
        let success = 0;
        let failed = 0;

        for (const item of itemsToUpdate) {
            try {
                zohoStatusEl.textContent = `Updating status ${success + failed + 1}/${itemsToUpdate.length}...`;
                zohoStatusEl.className = 'text-sm text-blue-500';

                const response = await fetch('/api/shopify/update-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accessToken: shopifyToken,
                        productId: item.productId,
                        status: newStatus
                    })
                });

                const data = await response.json();
                if (data.error) throw new Error(data.error);

                shopifyStatusData[item.sku] = newStatus;
                success++;
            } catch (error) {
                failed++;
            }
        }

        // Re-render table to show updated statuses
        renderTable();

        if (failed === 0) {
            zohoStatusEl.textContent = `Set ${success} items to ${newStatus}`;
            zohoStatusEl.className = 'text-sm text-green-600';
        } else {
            zohoStatusEl.textContent = `Updated ${success}, failed ${failed}`;
            zohoStatusEl.className = 'text-sm text-orange-500';
        }

        batchStatusSelect.disabled = false;
        batchStatusSelect.value = '';
    });
}

// ============================================
// PRODUCT DESCRIPTIONS TAB
// ============================================

// --- DESCRIPTIONS STATE ---
let descriptionsData = []; // Data from /api/descriptions
let descFilteredData = [];
let descCurrentPage = 1;
const DESC_PAGE_SIZE = 50;
let descDataLoaded = false;
let rewrittenData = {}; // SKU -> { rewrittenDescription, rewrittenProductUses }
let descSortField = 'sku';
let descSortDirection = 'asc';

// --- STORAGE KEYS ---
const API_KEYS_STORAGE_KEY = 'price_dashboard_api_keys';
const REWRITE_PROMPT_KEY = 'price_dashboard_rewrite_prompt';
const HTML_TITLE_RULES_KEY = 'price_dashboard_html_title_rules';
const META_DESC_RULES_KEY = 'price_dashboard_meta_desc_rules';
const REWRITTEN_DATA_KEY = 'price_dashboard_rewritten';
const OPTIONS_STORAGE_KEY = 'price_dashboard_options';
const DEBUG_LOG_KEY = 'price_dashboard_debug_logs';
const SHOPIFY_TOKEN_KEY = 'price_dashboard_shopify_token';
const MAX_DEBUG_LOGS = 500;

// --- DEBUG LOGGING ---
function debugLog(type, category, message, data = null) {
    try {
        const logs = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]');
        logs.unshift({
            timestamp: new Date().toISOString(),
            type, // 'error', 'warn', 'info', 'success'
            category,
            message,
            data
        });
        localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(logs.slice(0, MAX_DEBUG_LOGS)));
    } catch (e) {
        console.error('Debug log failed:', e);
    }
}

const DEFAULT_PROMPT = `You are a product copywriter. Rewrite the following product content to be more engaging, clear, and SEO-friendly while maintaining accuracy.

Product Name: {name}

Original Description:
{description}

Original Product Uses:
{productUses}

Please provide:
1. A rewritten description (2-3 concise paragraphs, plain text)
2. A rewritten product uses section - MUST be formatted as an HTML unordered list with line breaks after each item for proper spacing:
   <ul><li>Use 1</li><br><li>Use 2</li><br><li>Use 3</li></ul>

   IMPORTANT: Always include <br> after each </li> tag (except the last one) to ensure proper line spacing in the rendered output.`;

const DEFAULT_HTML_TITLE_RULES = `Generate an SEO-optimized HTML title tag:
- Maximum 60 characters
- Include the product name
- Put primary keyword near the beginning
- Make it compelling and click-worthy`;

const DEFAULT_META_DESC_RULES = `Generate an SEO-optimized meta description:
- Maximum 155 characters
- Include a clear call-to-action
- Mention key product benefits
- Make it enticing for search results`;

// --- DESCRIPTIONS DOM ELEMENTS ---
const descTableBody = document.getElementById('descriptions-table-body');
const descFilterSkuEl = document.getElementById('desc-filter-sku');
const descFilterNameEl = document.getElementById('desc-filter-name');
const descPageInfoEl = document.getElementById('desc-page-info');
const descPrevPageBtn = document.getElementById('desc-prev-page');
const descNextPageBtn = document.getElementById('desc-next-page');
const descLoadingEl = document.getElementById('desc-loading');
const descStatsEl = document.getElementById('desc-stats');
const syncToShopifyBtn = document.getElementById('sync-to-shopify');
const shopifyStatusEl = document.getElementById('shopify-status');
const descCheckAllEl = document.getElementById('desc-check-all');
const rewriteSelectedBtn = document.getElementById('rewrite-selected-btn');

// Modal elements
const apiKeysModal = document.getElementById('api-keys-modal');
const apiSettingsBtn = document.getElementById('api-settings-btn');
const closeApiModalBtn = document.getElementById('close-api-modal');
const claudeApiKeyEl = document.getElementById('claude-api-key');
const openaiApiKeyEl = document.getElementById('openai-api-key');
const geminiApiKeyEl = document.getElementById('gemini-api-key');
const tensorixApiKeyEl = document.getElementById('tensorix-api-key');
const tensorixModelEl = document.getElementById('tensorix-model');
const saveApiKeysBtn = document.getElementById('save-api-keys');
const clearApiKeysBtn = document.getElementById('clear-api-keys');

const promptModal = document.getElementById('prompt-modal');
const promptSettingsBtn = document.getElementById('prompt-settings-btn');
const closePromptModalBtn = document.getElementById('close-prompt-modal');
const rewritePromptEl = document.getElementById('rewrite-prompt');
const htmlTitleRulesEl = document.getElementById('html-title-rules');
const metaDescRulesEl = document.getElementById('meta-desc-rules');
const resetPromptBtn = document.getElementById('reset-prompt');
const cancelPromptBtn = document.getElementById('cancel-prompt');
const savePromptBtn = document.getElementById('save-prompt');

const textEditorModal = document.getElementById('text-editor-modal');
const editorTitle = document.getElementById('editor-title');
const editorSku = document.getElementById('editor-sku');
const editorTextarea = document.getElementById('editor-textarea');
const editorCharCount = document.getElementById('editor-char-count');
const closeEditorModalBtn = document.getElementById('close-editor-modal');
const closeEditorBtn = document.getElementById('close-editor-btn');
const rewriteEditorBtn = document.getElementById('rewrite-editor');

// Editor state
let currentEditSku = null;
let currentEditField = null;

// Shift-click selection state for descriptions
let descLastClickedIndex = null;

// Options elements
const optionsBtn = document.getElementById('options-btn');
const optionsPopover = document.getElementById('options-popover');
const optGenerateUsesEl = document.getElementById('opt-generate-uses');
const optGenerateSeoEl = document.getElementById('opt-generate-seo');

// --- OPTIONS STORAGE ---
function saveOptions() {
    const options = {
        generateUsesIfEmpty: optGenerateUsesEl?.checked || false,
        generateSeo: optGenerateSeoEl?.checked !== false
    };
    localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(options));
}

function loadOptions() {
    try {
        const stored = localStorage.getItem(OPTIONS_STORAGE_KEY);
        return stored ? JSON.parse(stored) : { generateUsesIfEmpty: false, generateSeo: true };
    } catch {
        return { generateUsesIfEmpty: false, generateSeo: true };
    }
}

// --- STORAGE FUNCTIONS ---
function saveApiKeys() {
    const defaultLlm = document.querySelector('input[name="default-llm"]:checked')?.value || 'claude';
    const keys = {
        claude: claudeApiKeyEl?.value || '',
        openai: openaiApiKeyEl?.value || '',
        gemini: geminiApiKeyEl?.value || '',
        tensorix: tensorixApiKeyEl?.value || '',
        tensorixModel: tensorixModelEl?.value || 'z-ai/glm-4.7',
        defaultLlm
    };
    localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys));
}

function loadApiKeys() {
    try {
        const stored = localStorage.getItem(API_KEYS_STORAGE_KEY);
        const defaults = { claude: '', openai: '', gemini: '', tensorix: '', tensorixModel: 'openai/gpt-oss-20b', defaultLlm: 'claude' };
        return stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
    } catch {
        return { claude: '', openai: '', gemini: '', tensorix: '', tensorixModel: 'openai/gpt-oss-20b', defaultLlm: 'claude' };
    }
}

function clearApiKeys() {
    localStorage.removeItem(API_KEYS_STORAGE_KEY);
    if (claudeApiKeyEl) claudeApiKeyEl.value = '';
    if (openaiApiKeyEl) openaiApiKeyEl.value = '';
    if (geminiApiKeyEl) geminiApiKeyEl.value = '';
    if (tensorixApiKeyEl) tensorixApiKeyEl.value = '';
}

function saveRewritePrompt(prompt) {
    localStorage.setItem(REWRITE_PROMPT_KEY, prompt);
}

function loadRewritePrompt() {
    const mainPrompt = localStorage.getItem(REWRITE_PROMPT_KEY) || DEFAULT_PROMPT;
    const htmlTitleRules = localStorage.getItem(HTML_TITLE_RULES_KEY) || DEFAULT_HTML_TITLE_RULES;
    const metaDescRules = localStorage.getItem(META_DESC_RULES_KEY) || DEFAULT_META_DESC_RULES;

    // Build the complete prompt with SEO rules
    return `${mainPrompt}

HTML Title Requirements:
${htmlTitleRules}

Meta Description Requirements:
${metaDescRules}

Format your response as JSON:
{"rewrittenDescription": "...", "rewrittenProductUses": "...", "htmlTitle": "...", "metaDescription": "..."}`;
}

function loadMainPrompt() {
    return localStorage.getItem(REWRITE_PROMPT_KEY) || DEFAULT_PROMPT;
}

function loadHtmlTitleRules() {
    return localStorage.getItem(HTML_TITLE_RULES_KEY) || DEFAULT_HTML_TITLE_RULES;
}

function loadMetaDescRules() {
    return localStorage.getItem(META_DESC_RULES_KEY) || DEFAULT_META_DESC_RULES;
}

function saveRewrittenData() {
    localStorage.setItem(REWRITTEN_DATA_KEY, JSON.stringify(rewrittenData));
}

function loadRewrittenData() {
    try {
        const stored = localStorage.getItem(REWRITTEN_DATA_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

// --- API ---
async function fetchDescriptionsData() {
    debugLog('info', 'fetch', 'Starting to fetch descriptions data');
    try {
        const response = await fetch('/api/descriptions');
        debugLog('info', 'fetch', `Response status: ${response.status}`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        debugLog('success', 'fetch', `Loaded ${data.length} descriptions`);
        return data;
    } catch (error) {
        debugLog('error', 'fetch', `Failed to load descriptions: ${error.message}`);
        if (descLoadingEl) {
            descLoadingEl.textContent = 'Failed to load descriptions: ' + error.message;
        }
        return [];
    }
}

// --- LLM API CALLS ---
async function callClaudeApi(apiKey, prompt) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Claude API error');
    }
    const data = await response.json();
    return data.content[0].text;
}

async function callOpenAiApi(apiKey, prompt) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 2048
        })
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'OpenAI API error');
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

async function callGeminiApi(apiKey, prompt) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Gemini API error');
    }
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

async function callTensorixApi(apiKey, prompt, model) {
    const response = await fetch('https://api.tensorix.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model || 'openai/gpt-oss-20b',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 2048,
            temperature: 0.7
        })
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Tensorix API error');
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

async function rewriteWithLlm(product) {
    const keys = loadApiKeys();
    const options = loadOptions();
    let promptTemplate = loadRewritePrompt();

    debugLog('info', 'rewrite', `Starting rewrite for SKU: ${product.sku}`, {
        llm: keys.defaultLlm,
        generateUsesIfEmpty: options.generateUsesIfEmpty,
        generateSeo: options.generateSeo,
        promptHasSeoFields: promptTemplate.includes('htmlTitle') && promptTemplate.includes('metaDescription')
    });

    
    // Handle generateUsesIfEmpty option
    let productUsesText = product.productUses || '';
    if (options.generateUsesIfEmpty && !productUsesText.trim()) {
        productUsesText = '(No product uses provided - please generate appropriate product uses based on the description)';
        debugLog('info', 'rewrite', 'Product uses empty - requesting LLM to generate');
    }

    const prompt = promptTemplate
        .replace('{name}', product.name || '')
        .replace('{description}', product.description || '')
        .replace('{productUses}', productUsesText);

    let result;
    const llm = keys.defaultLlm || 'claude';

    debugLog('info', 'rewrite', `Calling ${llm} API...`);

    try {
        if (llm === 'claude' && keys.claude) {
            result = await callClaudeApi(keys.claude, prompt);
        } else if (llm === 'openai' && keys.openai) {
            result = await callOpenAiApi(keys.openai, prompt);
        } else if (llm === 'gemini' && keys.gemini) {
            result = await callGeminiApi(keys.gemini, prompt);
        } else if (llm === 'tensorix' && keys.tensorix) {
            result = await callTensorixApi(keys.tensorix, prompt, keys.tensorixModel);
        } else {
            throw new Error('No API key configured for selected provider');
        }
    } catch (apiError) {
        debugLog('error', 'rewrite', `API call failed: ${apiError.message}`);
        throw apiError;
    }

    debugLog('info', 'rewrite', 'Raw LLM response received', { responseLength: result?.length, responsePreview: result?.substring(0, 200) });

    // Check for null/empty response
    if (!result) {
        debugLog('error', 'rewrite', 'LLM returned empty response');
        throw new Error('LLM returned empty response');
    }

    // Strip markdown code blocks if present
    let cleanedResult = result.trim();
    cleanedResult = cleanedResult.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
    cleanedResult = cleanedResult.replace(/\s*```$/i, '');
    cleanedResult = cleanedResult.trim();

    // Try to parse directly first
    try {
        const parsed = JSON.parse(cleanedResult);
        debugLog('success', 'rewrite', `Rewrite complete for SKU: ${product.sku}`, {
            hasDescription: !!parsed.rewrittenDescription,
            hasUses: !!parsed.rewrittenProductUses,
            hasHtmlTitle: !!parsed.htmlTitle,
            hasMetaDesc: !!parsed.metaDescription
        });
        return parsed;
    } catch (directParseError) {
        // Fallback: try to extract JSON with regex
        const jsonMatch = cleanedResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                debugLog('success', 'rewrite', `Rewrite complete for SKU: ${product.sku}`, {
                    hasDescription: !!parsed.rewrittenDescription,
                    hasUses: !!parsed.rewrittenProductUses,
                    hasHtmlTitle: !!parsed.htmlTitle,
                    hasMetaDesc: !!parsed.metaDescription
                });
                return parsed;
            } catch (parseError) {
                debugLog('error', 'rewrite', `JSON parse failed: ${parseError.message}`, { jsonAttempt: jsonMatch[0].substring(0, 200) });
                throw new Error('Failed to parse LLM response as JSON');
            }
        }
    }
    debugLog('error', 'rewrite', 'No JSON found in response', { responsePreview: cleanedResult?.substring(0, 300) });
    throw new Error('Invalid response format from LLM');
}

// --- DESCRIPTIONS FUNCTIONS ---
function truncateText(text, maxLength = 50) {
    if (!text) return '';
    // Ensure text is a string
    const str = String(text);
    const cleaned = str.replace(/\n/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.substring(0, maxLength) + '...';
}

function escapeHtml(text) {
    if (!text) return '';
    // Ensure text is a string
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDescTimestamp(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month} ${hours}:${mins}`;
}

function applyDescFilters() {
    const skuFilter = descFilterSkuEl?.value.toLowerCase().trim() || '';
    const nameFilter = descFilterNameEl?.value.toLowerCase().trim() || '';

    descFilteredData = descriptionsData.filter(p => {
        const skuMatch = !skuFilter || (p.sku || '').toLowerCase().includes(skuFilter);
        const nameMatch = !nameFilter || (p.name || '').toLowerCase().includes(nameFilter);
        return skuMatch && nameMatch;
    });

    // Apply sorting
    sortDescData();

    descCurrentPage = 1;
    renderDescriptionsTable();
}

function sortDescData() {
    descFilteredData.sort((a, b) => {
        let valA, valB;

        // Get value based on field
        if (['rewrittenDescription', 'rewrittenProductUses', 'htmlTitle', 'metaDescription', 'updatedAt', 'syncedAt'].includes(descSortField)) {
            const rewrittenA = rewrittenData[a.sku] || {};
            const rewrittenB = rewrittenData[b.sku] || {};
            valA = rewrittenA[descSortField] || '';
            valB = rewrittenB[descSortField] || '';
        } else {
            valA = a[descSortField] || '';
            valB = b[descSortField] || '';
        }

        // Handle string comparison
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        let result = 0;
        if (valA < valB) result = -1;
        if (valA > valB) result = 1;

        return descSortDirection === 'asc' ? result : -result;
    });
}

function handleDescSort(field) {
    if (descSortField === field) {
        descSortDirection = descSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        descSortField = field;
        descSortDirection = 'asc';
    }

    // Update sort indicators
    document.querySelectorAll('.desc-sortable .sort-indicator').forEach(el => {
        el.textContent = '↕';
    });
    const activeHeader = document.querySelector(`.desc-sortable[data-sort="${field}"] .sort-indicator`);
    if (activeHeader) {
        activeHeader.textContent = descSortDirection === 'asc' ? '↑' : '↓';
    }

    sortDescData();
    renderDescriptionsTable();
}

function renderDescriptionsTable() {
    if (!descTableBody) return;

    descTableBody.innerHTML = '';

    const totalPages = Math.ceil(descFilteredData.length / DESC_PAGE_SIZE);
    const startIdx = (descCurrentPage - 1) * DESC_PAGE_SIZE;
    const endIdx = Math.min(startIdx + DESC_PAGE_SIZE, descFilteredData.length);
    const pageData = descFilteredData.slice(startIdx, endIdx);

    if (pageData.length === 0) {
        descTableBody.innerHTML = '<tr><td colspan="11" class="px-3 py-8 text-center text-gray-500" style="height: 400px; vertical-align: middle;">No results found</td></tr>';
        updateDescPagination(0, 0);
        return;
    }

    pageData.forEach((product, idx) => {
        const row = document.createElement('tr');
        row.dataset.sku = product.sku;
        row.className = 'border-b border-gray-100 hover:bg-gray-50';

        const rewritten = rewrittenData[product.sku] || {};
        const truncatedDesc = truncateText(product.description);
        const truncatedUses = truncateText(product.productUses);
        const truncatedRewrittenDesc = truncateText(rewritten.rewrittenDescription);
        const truncatedRewrittenUses = truncateText(rewritten.rewrittenProductUses);
        const truncatedHtmlTitle = truncateText(rewritten.htmlTitle);
        const truncatedMetaDesc = truncateText(rewritten.metaDescription);

        const lastUpdated = rewritten.updatedAt ? formatDescTimestamp(rewritten.updatedAt) : '—';
        const lastSynced = rewritten.syncedAt ? formatDescTimestamp(rewritten.syncedAt) : '—';

        row.innerHTML = `
            <td class="px-2 py-1.5">
                <input type="checkbox" class="desc-row-check rounded border-gray-300" data-sku="${escapeHtml(product.sku)}">
            </td>
            <td class="px-2 py-1.5 text-gray-700 font-mono text-xs">${escapeHtml(product.sku)}</td>
            <td class="px-2 py-1.5 text-gray-900 truncate max-w-[10rem]" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</td>
            <td class="px-2 py-1.5 bg-blue-50/30">
                <span class="text-cell description" data-sku="${escapeHtml(product.sku)}" data-field="description" title="Click to view">${escapeHtml(truncatedDesc)}</span>
            </td>
            <td class="px-2 py-1.5 bg-amber-50/30">
                <span class="text-cell product-uses" data-sku="${escapeHtml(product.sku)}" data-field="productUses" title="Click to view">${escapeHtml(truncatedUses)}</span>
            </td>
            <td class="px-2 py-1.5 bg-green-50/30">
                <span class="text-cell rewritten" data-sku="${escapeHtml(product.sku)}" data-field="rewrittenDescription" title="Click to view">${escapeHtml(truncatedRewrittenDesc)}</span>
            </td>
            <td class="px-2 py-1.5 bg-purple-50/30">
                <span class="text-cell rewritten" data-sku="${escapeHtml(product.sku)}" data-field="rewrittenProductUses" title="Click to view">${escapeHtml(truncatedRewrittenUses)}</span>
            </td>
            <td class="px-2 py-1.5 bg-rose-50/30">
                <span class="text-cell seo" data-sku="${escapeHtml(product.sku)}" data-field="htmlTitle" title="Click to view">${escapeHtml(truncatedHtmlTitle)}</span>
            </td>
            <td class="px-2 py-1.5 bg-cyan-50/30">
                <span class="text-cell seo" data-sku="${escapeHtml(product.sku)}" data-field="metaDescription" title="Click to view">${escapeHtml(truncatedMetaDesc)}</span>
            </td>
            <td class="px-2 py-1.5 bg-gray-50/30 text-xs text-gray-500">${lastUpdated}</td>
            <td class="px-2 py-1.5 bg-green-50/30 text-xs text-gray-500">${lastSynced}</td>
        `;
        descTableBody.appendChild(row);
    });

    updateDescPagination(startIdx + 1, endIdx);
    updateDescStats();
}

function updateDescStats() {
    const withDesc = descFilteredData.filter(p => p.description).length;
    const withRewritten = descFilteredData.filter(p => rewrittenData[p.sku]?.rewrittenDescription).length;
    if (descStatsEl) {
        descStatsEl.textContent = `${descFilteredData.length} products • ${withDesc} with descriptions • ${withRewritten} rewritten`;
    }
}

function updateDescPagination(start, end) {
    const totalPages = Math.ceil(descFilteredData.length / DESC_PAGE_SIZE);

    if (descPageInfoEl) {
        if (descFilteredData.length === 0) {
            descPageInfoEl.textContent = 'No results';
        } else {
            descPageInfoEl.textContent = `Showing ${start}-${end} of ${descFilteredData.length}`;
        }
    }

    if (descPrevPageBtn) descPrevPageBtn.disabled = descCurrentPage <= 1;
    if (descNextPageBtn) descNextPageBtn.disabled = descCurrentPage >= totalPages;
}

function getSelectedSkus() {
    const checked = descTableBody?.querySelectorAll('.desc-row-check:checked') || [];
    return Array.from(checked).map(cb => cb.dataset.sku);
}

// --- TEXT EDITOR ---
function openTextEditor(sku, field) {
    const product = descriptionsData.find(p => p.sku === sku);
    if (!product) return;

    currentEditSku = sku;
    currentEditField = field;

    const isRewritten = field.startsWith('rewritten');
    const isSeo = field === 'htmlTitle' || field === 'metaDescription';
    const fieldLabels = {
        description: 'Product Description',
        productUses: 'Product Uses',
        rewrittenDescription: 'Rewritten Description',
        rewrittenProductUses: 'Rewritten Uses',
        htmlTitle: 'HTML Title',
        metaDescription: 'Meta Description'
    };

    let text = '';
    if (isRewritten || isSeo) {
        text = rewrittenData[sku]?.[field] || '';
    } else {
        text = product[field] || '';
    }

    if (editorTitle) editorTitle.textContent = fieldLabels[field] || field;
    if (editorSku) editorSku.textContent = `SKU: ${sku} — ${product.name}`;
    if (editorTextarea) {
        editorTextarea.value = text;
        updateCharCount();
    }

    // Show/hide rewrite button - hide for rewritten fields and SEO fields
    if (rewriteEditorBtn) {
        rewriteEditorBtn.style.display = (isRewritten || isSeo) ? 'none' : 'flex';
    }

    if (textEditorModal) {
        textEditorModal.classList.remove('hidden');
        textEditorModal.classList.add('active');
    }
}

function closeTextEditor() {
    if (textEditorModal) {
        textEditorModal.classList.add('hidden');
        textEditorModal.classList.remove('active');
    }
    currentEditSku = null;
    currentEditField = null;
}

function updateCharCount() {
    if (editorTextarea && editorCharCount) {
        editorCharCount.textContent = `${editorTextarea.value.length} characters`;
    }
}

async function rewriteCurrentItem() {
    if (!currentEditSku) return;

    const product = descriptionsData.find(p => p.sku === currentEditSku);
    if (!product) return;

    if (rewriteEditorBtn) {
        rewriteEditorBtn.disabled = true;
        rewriteEditorBtn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Rewriting...';
    }

    try {
        const result = await rewriteWithLlm(product);
        rewrittenData[currentEditSku] = {
            ...rewrittenData[currentEditSku],
            ...result,
            updatedAt: new Date().toISOString()
        };
        saveRewrittenData();
        renderDescriptionsTable();
        closeTextEditor();
    } catch (error) {
        alert('Rewrite failed: ' + error.message);
    } finally {
        if (rewriteEditorBtn) {
            rewriteEditorBtn.disabled = false;
            rewriteEditorBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Rewrite';
        }
    }
}

async function rewriteSelected() {
    const skus = getSelectedSkus();
    if (skus.length === 0) {
        if (shopifyStatusEl) {
            shopifyStatusEl.textContent = 'No items selected';
            shopifyStatusEl.className = 'text-sm text-orange-500';
        }
        return;
    }

    const keys = loadApiKeys();
    if (!keys.claude && !keys.openai && !keys.gemini && !keys.tensorix) {
        if (shopifyStatusEl) {
            shopifyStatusEl.textContent = 'Please configure API keys first';
            shopifyStatusEl.className = 'text-sm text-orange-500';
        }
        openApiKeysModal();
        return;
    }

    if (rewriteSelectedBtn) {
        rewriteSelectedBtn.disabled = true;
        rewriteSelectedBtn.textContent = 'Rewriting...';
    }

    // Add rewriting animation to all selected rows
    skus.forEach(sku => {
        const row = descTableBody?.querySelector(`tr[data-sku="${sku}"]`);
        if (row) row.classList.add('rewriting');
    });

    let success = 0;
    let failed = 0;

    for (const sku of skus) {
        const product = descriptionsData.find(p => p.sku === sku);
        if (!product) continue;

        const row = descTableBody?.querySelector(`tr[data-sku="${sku}"]`);

        try {
            if (shopifyStatusEl) {
                shopifyStatusEl.textContent = `Rewriting ${success + failed + 1}/${skus.length}...`;
                shopifyStatusEl.className = 'text-sm text-blue-500';
            }

            const result = await rewriteWithLlm(product);
            rewrittenData[sku] = { ...rewrittenData[sku], ...result, updatedAt: new Date().toISOString() };
            success++;

            // Update row with success animation
            if (row) {
                row.classList.remove('rewriting');
                row.classList.add('rewrite-success');
                // Update the cells with new data
                updateRowCells(row, sku);
                setTimeout(() => row.classList.remove('rewrite-success'), 1000);
            }
        } catch (error) {
            debugLog('error', 'rewrite', `Failed to rewrite ${sku}: ${error.message}`);
            failed++;
            if (row) row.classList.remove('rewriting');
        }
    }

    saveRewrittenData();

    if (rewriteSelectedBtn) {
        rewriteSelectedBtn.disabled = false;
        rewriteSelectedBtn.textContent = 'Rewrite Selected';
    }

    if (shopifyStatusEl) {
        shopifyStatusEl.textContent = `Rewritten ${success}, failed ${failed}`;
        shopifyStatusEl.className = failed > 0 ? 'text-sm text-orange-500' : 'text-sm text-green-600';
    }
}

// Helper to update row cells after rewrite without full re-render
function updateRowCells(row, sku) {
    const rewritten = rewrittenData[sku] || {};
    const cells = {
        rewrittenDescription: row.querySelector('[data-field="rewrittenDescription"]'),
        rewrittenProductUses: row.querySelector('[data-field="rewrittenProductUses"]'),
        htmlTitle: row.querySelector('[data-field="htmlTitle"]'),
        metaDescription: row.querySelector('[data-field="metaDescription"]')
    };

    if (cells.rewrittenDescription) cells.rewrittenDescription.textContent = truncateText(rewritten.rewrittenDescription);
    if (cells.rewrittenProductUses) cells.rewrittenProductUses.textContent = truncateText(rewritten.rewrittenProductUses);
    if (cells.htmlTitle) cells.htmlTitle.textContent = truncateText(rewritten.htmlTitle);
    if (cells.metaDescription) cells.metaDescription.textContent = truncateText(rewritten.metaDescription);
}

// --- MODALS ---
function openApiKeysModal() {
    const keys = loadApiKeys();
    if (claudeApiKeyEl) claudeApiKeyEl.value = keys.claude;
    if (openaiApiKeyEl) openaiApiKeyEl.value = keys.openai;
    if (geminiApiKeyEl) geminiApiKeyEl.value = keys.gemini;
    if (tensorixApiKeyEl) tensorixApiKeyEl.value = keys.tensorix;
    if (tensorixModelEl) tensorixModelEl.value = keys.tensorixModel || 'openai/gpt-oss-20b';

    const defaultRadio = document.getElementById(`default-${keys.defaultLlm}`);
    if (defaultRadio) defaultRadio.checked = true;

    if (apiKeysModal) {
        apiKeysModal.classList.remove('hidden');
        apiKeysModal.classList.add('active');
    }
}

function closeApiKeysModal() {
    if (apiKeysModal) {
        apiKeysModal.classList.add('hidden');
        apiKeysModal.classList.remove('active');
    }
}

function openPromptModal() {
    if (rewritePromptEl) {
        rewritePromptEl.value = loadMainPrompt();
    }
    if (htmlTitleRulesEl) {
        htmlTitleRulesEl.value = loadHtmlTitleRules();
    }
    if (metaDescRulesEl) {
        metaDescRulesEl.value = loadMetaDescRules();
    }
    if (promptModal) {
        promptModal.classList.remove('hidden');
        promptModal.classList.add('active');
    }
}

function closePromptModal() {
    if (promptModal) {
        promptModal.classList.add('hidden');
        promptModal.classList.remove('active');
    }
}

// --- EVENT LISTENERS ---
if (descFilterSkuEl) descFilterSkuEl.addEventListener('input', applyDescFilters);
if (descFilterNameEl) descFilterNameEl.addEventListener('input', applyDescFilters);

// Description column sorting
document.querySelectorAll('.desc-sortable').forEach(header => {
    header.addEventListener('click', () => {
        const field = header.dataset.sort;
        if (field) handleDescSort(field);
    });
});

if (descPrevPageBtn) {
    descPrevPageBtn.addEventListener('click', () => {
        if (descCurrentPage > 1) {
            descCurrentPage--;
            renderDescriptionsTable();
        }
    });
}

if (descNextPageBtn) {
    descNextPageBtn.addEventListener('click', () => {
        const totalPages = Math.ceil(descFilteredData.length / DESC_PAGE_SIZE);
        if (descCurrentPage < totalPages) {
            descCurrentPage++;
            renderDescriptionsTable();
        }
    });
}

// Check all
if (descCheckAllEl) {
    descCheckAllEl.addEventListener('change', () => {
        const checkboxes = descTableBody?.querySelectorAll('.desc-row-check') || [];
        checkboxes.forEach(cb => cb.checked = descCheckAllEl.checked);
    });
}

// Shift-click multi-select for descriptions
if (descTableBody) {
    descTableBody.addEventListener('click', (e) => {
        const checkbox = e.target.closest('.desc-row-check');
        if (!checkbox) return;

        const row = checkbox.closest('tr');
        const allRows = Array.from(descTableBody.querySelectorAll('tr'));
        const currentIndex = allRows.indexOf(row);

        if (e.shiftKey && descLastClickedIndex !== null) {
            const start = Math.min(descLastClickedIndex, currentIndex);
            const end = Math.max(descLastClickedIndex, currentIndex);

            allRows.slice(start, end + 1).forEach(r => {
                const cb = r.querySelector('.desc-row-check');
                if (cb) cb.checked = checkbox.checked;
            });
        }

        descLastClickedIndex = currentIndex;

        // Update check-all state
        const allCheckboxes = descTableBody.querySelectorAll('.desc-row-check');
        const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
        const someChecked = Array.from(allCheckboxes).some(cb => cb.checked);
        if (descCheckAllEl) {
            descCheckAllEl.checked = allChecked;
            descCheckAllEl.indeterminate = someChecked && !allChecked;
        }
    });
}

// Rewrite selected
if (rewriteSelectedBtn) {
    rewriteSelectedBtn.addEventListener('click', rewriteSelected);
}

// API Keys modal
if (apiSettingsBtn) apiSettingsBtn.addEventListener('click', openApiKeysModal);
if (closeApiModalBtn) closeApiModalBtn.addEventListener('click', closeApiKeysModal);
if (saveApiKeysBtn) {
    saveApiKeysBtn.addEventListener('click', () => {
        saveApiKeys();
        closeApiKeysModal();
    });
}
if (clearApiKeysBtn) clearApiKeysBtn.addEventListener('click', clearApiKeys);
if (apiKeysModal) {
    apiKeysModal.addEventListener('click', (e) => {
        if (e.target === apiKeysModal) closeApiKeysModal();
    });
}

// Prompt modal
if (promptSettingsBtn) promptSettingsBtn.addEventListener('click', openPromptModal);
if (closePromptModalBtn) closePromptModalBtn.addEventListener('click', closePromptModal);
if (cancelPromptBtn) cancelPromptBtn.addEventListener('click', closePromptModal);
if (savePromptBtn) {
    savePromptBtn.addEventListener('click', () => {
        if (rewritePromptEl) localStorage.setItem(REWRITE_PROMPT_KEY, rewritePromptEl.value);
        if (htmlTitleRulesEl) localStorage.setItem(HTML_TITLE_RULES_KEY, htmlTitleRulesEl.value);
        if (metaDescRulesEl) localStorage.setItem(META_DESC_RULES_KEY, metaDescRulesEl.value);
        debugLog('info', 'prompt', 'Saved prompt settings');
        closePromptModal();
    });
}
if (resetPromptBtn) {
    resetPromptBtn.addEventListener('click', () => {
        if (rewritePromptEl) rewritePromptEl.value = DEFAULT_PROMPT;
        if (htmlTitleRulesEl) htmlTitleRulesEl.value = DEFAULT_HTML_TITLE_RULES;
        if (metaDescRulesEl) metaDescRulesEl.value = DEFAULT_META_DESC_RULES;
    });
}
if (promptModal) {
    promptModal.addEventListener('click', (e) => {
        if (e.target === promptModal) closePromptModal();
    });
}

// Text editor modal
if (descTableBody) {
    descTableBody.addEventListener('click', (e) => {
        const textCell = e.target.closest('.text-cell');
        if (textCell) {
            openTextEditor(textCell.dataset.sku, textCell.dataset.field);
        }
    });
}

if (closeEditorModalBtn) closeEditorModalBtn.addEventListener('click', closeTextEditor);
if (closeEditorBtn) closeEditorBtn.addEventListener('click', closeTextEditor);
if (rewriteEditorBtn) rewriteEditorBtn.addEventListener('click', rewriteCurrentItem);
if (editorTextarea) editorTextarea.addEventListener('input', updateCharCount);
if (textEditorModal) {
    textEditorModal.addEventListener('click', (e) => {
        if (e.target === textEditorModal) closeTextEditor();
    });
}

// Escape key to close modals
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeApiKeysModal();
        closePromptModal();
        closeTextEditor();
    }
});

// --- SHOPIFY INTEGRATION ---
function getShopifyToken() {
    return localStorage.getItem(SHOPIFY_TOKEN_KEY);
}

function setShopifyToken(token) {
    localStorage.setItem(SHOPIFY_TOKEN_KEY, token);
}

function clearShopifyToken() {
    localStorage.removeItem(SHOPIFY_TOKEN_KEY);
}

function updateShopifyButton() {
    if (!syncToShopifyBtn) return;

    const token = getShopifyToken();
    if (token) {
        syncToShopifyBtn.textContent = 'Sync to Shopify';
        syncToShopifyBtn.classList.remove('bg-gray-500');
        syncToShopifyBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    } else {
        syncToShopifyBtn.textContent = 'Connect Shopify';
        syncToShopifyBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
        syncToShopifyBtn.classList.add('bg-gray-500');
    }
}

function handleShopifyOAuthReturn() {
    // Check URL for shopify_token parameter (from OAuth callback)
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('shopify_token');

    if (token) {
        setShopifyToken(token);
        debugLog('success', 'shopify', 'Shopify connected successfully');

        // Clean up URL
        const cleanUrl = window.location.origin + window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);

        if (shopifyStatusEl) {
            shopifyStatusEl.textContent = 'Shopify connected!';
            shopifyStatusEl.className = 'text-sm text-green-600';
        }

        updateShopifyButton();
    }
}

async function syncProductToShopify(sku, rewritten) {
    const token = getShopifyToken();
    if (!token) {
        throw new Error('Not connected to Shopify');
    }

    // Build combined description with Product Uses section
    let fullDescription = '';
    if (rewritten.rewrittenDescription) {
        fullDescription = rewritten.rewrittenDescription;
    }
    if (rewritten.rewrittenProductUses) {
        fullDescription += `<br><h2 class="card__title heading h3 h2">Product Uses</h2><br>${rewritten.rewrittenProductUses}`;
    }

    const response = await fetch('/api/shopify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accessToken: token,
            sku: sku,
            description: fullDescription || null,
            htmlTitle: rewritten.htmlTitle,
            metaDescription: rewritten.metaDescription
        })
    });

    const data = await response.json();

    if (data.error) {
        // Check if token is invalid
        if (data.error.includes('401') || data.error.includes('Unauthorized') || data.error.includes('access token')) {
            clearShopifyToken();
            updateShopifyButton();
        }
        throw new Error(data.error);
    }

    return data;
}

async function syncSelectedToShopify() {
    const token = getShopifyToken();

    // If not connected, start OAuth flow
    if (!token) {
        debugLog('info', 'shopify', 'Starting OAuth flow');
        window.location.href = '/api/shopify/auth';
        return;
    }

    const skus = getSelectedSkus();
    if (skus.length === 0) {
        if (shopifyStatusEl) {
            shopifyStatusEl.textContent = 'No items selected';
            shopifyStatusEl.className = 'text-sm text-orange-500';
        }
        return;
    }

    // Filter to only items with rewritten content
    const itemsToSync = skus.filter(sku => {
        const rewritten = rewrittenData[sku];
        return rewritten && (rewritten.rewrittenDescription || rewritten.htmlTitle || rewritten.metaDescription);
    });

    if (itemsToSync.length === 0) {
        if (shopifyStatusEl) {
            shopifyStatusEl.textContent = 'No rewritten content to sync';
            shopifyStatusEl.className = 'text-sm text-orange-500';
        }
        return;
    }

    syncToShopifyBtn.disabled = true;
    syncToShopifyBtn.textContent = 'Syncing...';

    let successItems = [];
    let failedItems = [];

    for (const sku of itemsToSync) {
        try {
            if (shopifyStatusEl) {
                shopifyStatusEl.textContent = `Syncing ${successItems.length + failedItems.length + 1}/${itemsToSync.length}...`;
                shopifyStatusEl.className = 'text-sm text-blue-500';
            }

            const rewritten = rewrittenData[sku];
            const result = await syncProductToShopify(sku, rewritten);
            rewrittenData[sku].syncedAt = new Date().toISOString();
            successItems.push(sku);
            debugLog('success', 'shopify', `Synced ${sku} to Shopify`, {
                debug: result.debug,
                hadHtmlTitle: !!rewritten.htmlTitle,
                hadMetaDesc: !!rewritten.metaDescription
            });
        } catch (error) {
            let errorMsg = error.message;
            // Make error messages more user-friendly
            if (errorMsg.includes('not found') || errorMsg.includes('404')) {
                errorMsg = 'SKU not found in Shopify';
            } else if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
                errorMsg = 'Not authorized - reconnect Shopify';
            }
            failedItems.push({ sku, error: errorMsg });
            debugLog('error', 'shopify', `Failed to sync ${sku}: ${error.message}`);
        }
    }

    // Save sync timestamps and update table
    saveRewrittenData();
    renderDescriptionsTable();

    syncToShopifyBtn.disabled = false;
    updateShopifyButton();

    // Clear inline status
    if (shopifyStatusEl) {
        shopifyStatusEl.textContent = '';
    }

    // Show detailed results
    displaySyncResults(successItems, failedItems);
}

function displaySyncResults(successItems, failedItems) {
    const resultsContainer = document.getElementById('sync-results');
    const resultsContent = document.getElementById('sync-results-content');

    if (!resultsContainer || !resultsContent) return;

    if (successItems.length === 0 && failedItems.length === 0) {
        resultsContainer.classList.add('hidden');
        return;
    }

    let html = '';

    if (failedItems.length === 0) {
        // All success
        resultsContent.className = 'p-3 rounded-lg text-sm bg-green-50 border border-green-200';
        html = `<div class="text-green-700 font-medium">✓ Synced ${successItems.length} product${successItems.length > 1 ? 's' : ''} to Shopify</div>`;
    } else if (successItems.length === 0) {
        // All failed
        resultsContent.className = 'p-3 rounded-lg text-sm bg-red-50 border border-red-200';
        html = `<div class="text-red-700 font-medium mb-2">✗ Failed to sync ${failedItems.length} product${failedItems.length > 1 ? 's' : ''}</div>`;
        html += '<ul class="text-red-600 text-xs space-y-1 ml-4">';
        failedItems.forEach(item => {
            html += `<li><span class="font-mono">${escapeHtml(item.sku)}</span>: ${escapeHtml(item.error)}</li>`;
        });
        html += '</ul>';
    } else {
        // Mixed results
        resultsContent.className = 'p-3 rounded-lg text-sm bg-orange-50 border border-orange-200';
        html = `<div class="text-green-700 font-medium">✓ Synced ${successItems.length} product${successItems.length > 1 ? 's' : ''}</div>`;
        html += `<div class="text-red-700 font-medium mt-2 mb-1">✗ Failed ${failedItems.length}:</div>`;
        html += '<ul class="text-red-600 text-xs space-y-1 ml-4">';
        failedItems.forEach(item => {
            html += `<li><span class="font-mono">${escapeHtml(item.sku)}</span>: ${escapeHtml(item.error)}</li>`;
        });
        html += '</ul>';
    }

    resultsContent.innerHTML = html;
    resultsContainer.classList.remove('hidden');

    // Auto-hide after 10 seconds if all success
    if (failedItems.length === 0) {
        setTimeout(() => {
            resultsContainer.classList.add('hidden');
        }, 10000);
    }
}

// Sync to Shopify button
if (syncToShopifyBtn) {
    syncToShopifyBtn.addEventListener('click', syncSelectedToShopify);
}

// Initialize descriptions tab
async function initDescriptionsTab() {
    debugLog('info', 'init', 'Initializing descriptions tab', { alreadyLoaded: descDataLoaded });
    if (!descDataLoaded) {
        try {
            rewrittenData = loadRewrittenData();
            debugLog('info', 'init', `Loaded ${Object.keys(rewrittenData).length} rewritten items from storage`);

            descriptionsData = await fetchDescriptionsData();
            descFilteredData = [...descriptionsData];
            descDataLoaded = true;

            debugLog('info', 'init', `Rendering ${descFilteredData.length} items`);
            renderDescriptionsTable();
            debugLog('success', 'init', 'Descriptions tab initialized successfully');
        } catch (error) {
            debugLog('error', 'init', `Init failed: ${error.message}`);
            if (descLoadingEl) {
                descLoadingEl.textContent = 'Failed to initialize: ' + error.message;
            }
        } finally {
            // Always hide loading indicator
            document.body.classList.add('desc-loaded');
        }
    }
}

// Listen for tab activation from inline script
window.addEventListener('descriptions-tab-activated', initDescriptionsTab);

// Also handle direct click (fallback)
document.getElementById('tab-descriptions')?.addEventListener('click', initDescriptionsTab);

// Options popover toggle
if (optionsBtn && optionsPopover) {
    optionsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        optionsPopover.classList.toggle('hidden');
    });

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
        if (!optionsPopover.contains(e.target) && e.target !== optionsBtn) {
            optionsPopover.classList.add('hidden');
        }
    });
}

// Save options when checkboxes change
if (optGenerateUsesEl) {
    optGenerateUsesEl.addEventListener('change', saveOptions);
}
if (optGenerateSeoEl) {
    optGenerateSeoEl.addEventListener('change', saveOptions);
}

// Load API keys and options on page load
document.addEventListener('DOMContentLoaded', () => {
    debugLog('info', 'startup', 'Dashboard loading...');

    const savedKeys = loadApiKeys();
    if (claudeApiKeyEl) claudeApiKeyEl.value = savedKeys.claude;
    if (openaiApiKeyEl) openaiApiKeyEl.value = savedKeys.openai;
    if (geminiApiKeyEl) geminiApiKeyEl.value = savedKeys.gemini;
    if (tensorixApiKeyEl) tensorixApiKeyEl.value = savedKeys.tensorix;

    // Load options
    const savedOptions = loadOptions();
    if (optGenerateUsesEl) optGenerateUsesEl.checked = savedOptions.generateUsesIfEmpty;
    if (optGenerateSeoEl) optGenerateSeoEl.checked = savedOptions.generateSeo;

    
    // Handle Shopify OAuth return and update button state
    handleShopifyOAuthReturn();
    updateShopifyButton();

    debugLog('success', 'startup', 'Dashboard loaded', {
        hasClaudeKey: !!savedKeys.claude,
        hasOpenAiKey: !!savedKeys.openai,
        hasGeminiKey: !!savedKeys.gemini,
        hasTensorixKey: !!savedKeys.tensorix,
        defaultLlm: savedKeys.defaultLlm,
        shopifyConnected: !!getShopifyToken()
    });
});
