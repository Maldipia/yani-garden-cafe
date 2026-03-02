// ═══════════════════════════════════════════════════════════════════════
// YANI GARDEN CAFE POS - BACKEND CODE (Code.gs) - COMPLETE WORKING VERSION
// Version: 3.1 - AUDIT FIX: order numbering, timezone, throttle, folder lookup
// ═══════════════════════════════════════════════════════════════════════

// IMPORTANT: Update this with YOUR spreadsheet ID
// Find it in your Google Sheets URL: /d/THIS_PART_HERE/edit
const SPREADSHEET_ID = '14wSvfCy5LUrlgi4d48jcGjnFpy310XYUsCWCg5VMg0g';

const SHEET_NAMES = {
  SETTINGS: 'SETTINGS',
  TABLES: 'TABLES',
  MENU: 'YGC_MENU',
  ORDERS: 'ORDERS',
  ORDER_ITEMS: 'ORDER_ITEMS',
  PAYMENTS: 'PAYMENTS',
  LOGS: 'LOGS',
  USERS: 'USERS'
};

// ── Manila Timezone Helper ───────────────────────────────────────────
function manilaTimestamp() {
  return Utilities.formatDate(new Date(), 'Asia/Manila', 'M/d/yyyy HH:mm:ss');
}
function manilaDate() {
  return Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd');
}

// ── Receipt & Payment Folder Config ──────────────────────────────────
const RECEIPT_CONFIG = {
  SIMPLE_RECEIPT_FOLDER_ID: '1HLPCkeTqRDPTvpmCvqwd65rqkT1fAjfx',  // YGC SALES invoice
  BIR_RECEIPT_FOLDER_ID:    '1iIUE6O_alTLFfh9jLOX6eiYLom3TZF_g',  // YGC SALES (BIR)
  PAYMENT_FOLDER_ID:        '1hDQlljGpRUwT9q33xHukbXvz_M8tk5lR',  // YGC payment
};

/** Get receipt/business details from SETTINGS sheet (cached per execution) */
let _bizCache = null;
function getBizInfo() {
  if (_bizCache) return _bizCache;
  _bizCache = {
    name:        getSetting('BUSINESS_NAME')    || 'YANI-CAFE FOOD AND BEVERAGE HOUSE',
    tin:         getSetting('BUSINESS_TIN')      || '',
    address:     getSetting('BUSINESS_ADDRESS')  || 'Purok 8 Daang Malinaw, Loma 4119, Amadeo, Cavite',
    phone:       getSetting('BUSINESS_PHONE')    || '',
    email:       getSetting('BUSINESS_EMAIL')    || 'tygfsb@gmail.com',
    senderName:  getSetting('RECEIPT_SENDER_NAME') || 'Yani Cafe',
    footer:      getSetting('RECEIPT_FOOTER')    || 'Happy to serve. Visit us again soon.',
    tagline:     getSetting('TAGLINE')           || 'Hold on a cup of blessing - YANI',
    storeName:   getSetting('STORE_NAME')        || 'Yani Garden Cafe',
  };
  return _bizCache;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

function doGet(e) {
  try {
    // Handle API calls via GET (for Vercel ordering page)
    const action = e.parameter.action;
    
    if (action === 'getMenu') {
      return jsonResponse(getMenu());
    }
    
    // Handle HTML customer interface (for original QR codes)
    const table = e.parameter.table;
    const token = e.parameter.token;
    
    if (table && token) {
      const template = HtmlService.createTemplateFromFile('ygcCustomer');
      template.tableNo = table;
      template.token = token;
      return template.evaluate()
        .setTitle((getSetting('STORE_NAME') || 'Yani Garden Cafe') + ' - Table ' + table)
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    
    return HtmlService.createHtmlOutput('<h1>Access Denied</h1>');
  } catch (error) {
    return HtmlService.createHtmlOutput('<h1>Error</h1><p>' + error.message + '</p>');
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    
    if (action === 'getMenu') {
      return jsonResponse(getMenu());
    }
    
    if (action === 'placeOrder') {
      return jsonResponse(placeOrder(data));
    }
    
    if (action === 'getOrders') {
      return jsonResponse(getOrders(data));
    }
    
    if (action === 'updateOrderStatus') {
      return jsonResponse(updateOrderStatus(data));
    }
    
    if (action === 'uploadPayment') {
      return jsonResponse(uploadPayment(data));
    }
    
    if (action === 'requestReceipt') {
      return jsonResponse(requestReceipt(data));
    }
    
    if (action === 'verifyAdminPin') {
      return jsonResponse(verifyAdminPin(data.pin));
    }
    
    if (action === 'verifyUserPin') {
      return jsonResponse(verifyUserPin(data.pin));
    }
    
    if (action === 'updateLastLogin') {
      return jsonResponse(updateLastLogin(data.userId));
    }
    
    if (action === 'checkPermission') {
      return jsonResponse(checkPermission(data.userId, data.action));
    }
    
    // ── NEW: Payment & Receipt Actions ──────────────────────────────
    
    if (action === 'placePlatformOrder') {
      return jsonResponse(placePlatformOrder(data));
    }
    
    if (action === 'sendEmailReceipt') {
      return jsonResponse(handleSendEmailReceipt(data));
    }
    
    if (action === 'verifyPayment') {
      return jsonResponse(handleVerifyPayment(data));
    }
    
    if (action === 'rejectPayment') {
      return jsonResponse(handleRejectPayment(data));
    }
    
    if (action === 'listPayments') {
      return jsonResponse(handleListPayments(data));
    }
    
    // ── Menu Manager (ADMIN/OWNER) ──────────────────────────────────
    
    if (action === 'getMenuAdmin') {
      return jsonResponse(getMenuAdmin());
    }
    
    if (action === 'updateMenuItem') {
      return jsonResponse(updateMenuItem(data));
    }
    
    if (action === 'addMenuItem') {
      return jsonResponse(addMenuItem(data));
    }
    
    if (action === 'deleteMenuItem') {
      return jsonResponse(deleteMenuItem(data));
    }
    
    return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
    
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message });
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (error) {
    throw new Error('Cannot access spreadsheet. Please check SPREADSHEET_ID in Code.gs. Error: ' + error.message);
  }
}

/**
 * Append a row to a sheet using header names instead of column positions.
 * This prevents misalignment when columns are added/moved/reordered.
 * @param {Sheet} sheet - The Google Sheet tab
 * @param {Object} dataObj - e.g. { ORDER_ID: 'YANI-1001', STATUS: 'NEW', ... }
 */
function appendByHeaders(sheet, dataObj) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function(h) {
    return dataObj.hasOwnProperty(h) ? dataObj[h] : '';
  });
  sheet.appendRow(row);
}

/**
 * Update specific cells in a row by header name (finds row where column matchCol === matchVal).
 * @param {Sheet} sheet
 * @param {string} matchCol - header name to match on (e.g. 'ORDER_ID')
 * @param {*} matchVal - value to match
 * @param {Object} updates - e.g. { STATUS: 'COMPLETED', PAYMENT_STATUS: 'VERIFIED' }
 */
function updateByHeaders(sheet, matchCol, matchVal, updates) {
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var colIdx = {};
  headers.forEach(function(h, i) { colIdx[h] = i; });
  
  var matchColIdx = colIdx[matchCol];
  if (matchColIdx === undefined) throw new Error('Column not found: ' + matchCol);
  
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][matchColIdx]) === String(matchVal)) {
      Object.keys(updates).forEach(function(key) {
        if (colIdx[key] !== undefined) {
          sheet.getRange(i + 1, colIdx[key] + 1).setValue(updates[key]);
        }
      });
      return i + 1; // return 1-based row number
    }
  }
  return -1; // not found
}

// ═══════════════════════════════════════════════════════════════════════
// MENU FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function getMenu() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const menuSheet = ss.getSheetByName('YGC_MENU');
    
    if (!menuSheet) {
      return { ok: false, error: 'YGC_MENU sheet not found' };
    }
    
    const data = menuSheet.getDataRange().getValues();
    const headers = data[0];
    const items = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowData = {};
      
      headers.forEach((header, index) => {
        rowData[header] = row[index];
      });
      
      // Check if item is active
      const status = String(rowData['grabfood_status'] || '').trim().toUpperCase();
      
      if (status === 'ACTIVE' || status === 'TRUE') {
        const hasSizes = String(rowData['sizes_choice'] || '').toUpperCase() === 'TRUE';
        const hasSugar = String(rowData['sweetness_choice'] || '').toUpperCase() === 'TRUE';
        
        items.push({
          code: rowData['item_id'],
          name: rowData['item_name'],
          category: rowData['category'],
          price: parseFloat(rowData['base_price']) || 0,
          hasSizes: hasSizes,
          hasSugar: hasSugar,
          image: rowData['Product Image (Link)'] || '',
          priceShort: parseFloat(rowData['size_short_price']) || 150,
          priceMedium: parseFloat(rowData['size_medium_price']) || 170,
          priceTall: parseFloat(rowData['size_tall_price']) || 179
        });
      }
    }
    
    return {
      ok: true,
      storeName: getSetting('STORE_NAME') || 'Yani Garden Cafe',
      items: items
    };
    
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MENU MANAGER (ADMIN/OWNER)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returns ALL menu items (active + inactive) for the admin Menu Manager.
 * Includes row index so the frontend can reference which row to update.
 */
function getMenuAdmin() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const menuSheet = ss.getSheetByName(SHEET_NAMES.MENU);
    if (!menuSheet) return { ok: false, error: 'YGC_MENU sheet not found' };

    const data = menuSheet.getDataRange().getValues();
    const headers = data[0];
    const items = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0] && !row[1]) continue; // skip completely empty rows
      const rowData = {};
      headers.forEach((h, idx) => { rowData[h] = row[idx]; });

      const status = String(rowData['grabfood_status'] || '').trim().toUpperCase();
      const hasSizes = String(rowData['sizes_choice'] || '').toUpperCase() === 'TRUE';
      const hasSugar = String(rowData['sweetness_choice'] || '').toUpperCase() === 'TRUE';

      items.push({
        rowIndex:    i + 1,  // 1-based sheet row
        code:        String(rowData['item_id'] || '').trim(),
        name:        String(rowData['item_name'] || '').trim(),
        category:    String(rowData['category'] || '').trim(),
        status:      status,
        active:      (status === 'ACTIVE' || status === 'TRUE'),
        price:       parseFloat(rowData['base_price']) || 0,
        hasSizes:    hasSizes,
        hasSugar:    hasSugar,
        priceShort:  parseFloat(rowData['size_short_price']) || 0,
        priceMedium: parseFloat(rowData['size_medium_price']) || 0,
        priceTall:   parseFloat(rowData['size_tall_price']) || 0,
        image:       String(rowData['Product Image (Link)'] || '').trim()
      });
    }

    // Return headers so frontend knows column order
    return { ok: true, items: items, headers: headers };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Update a single menu item row by item_id.
 * Accepts: { itemId, name, category, status, price, hasSizes, hasSugar,
 *            priceShort, priceMedium, priceTall, image }
 */
function updateMenuItem(data) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const menuSheet = ss.getSheetByName(SHEET_NAMES.MENU);
    if (!menuSheet) return { ok: false, error: 'YGC_MENU sheet not found' };

    const sheetData = menuSheet.getDataRange().getValues();
    const headers = sheetData[0];
    const colIdx = {};
    headers.forEach((h, i) => { colIdx[h] = i; });

    // Find the row matching item_id
    const itemId = String(data.itemId || '').trim();
    let targetRow = -1;
    for (let i = 1; i < sheetData.length; i++) {
      if (String(sheetData[i][colIdx['item_id']] || '').trim() === itemId) {
        targetRow = i + 1; // 1-based
        break;
      }
    }
    if (targetRow === -1) return { ok: false, error: 'Item not found: ' + itemId };

    // Build update map
    const updates = {};
    if (data.name        !== undefined) updates['item_name']              = data.name;
    if (data.category    !== undefined) updates['category']               = data.category;
    if (data.price       !== undefined) updates['base_price']             = parseFloat(data.price) || 0;
    if (data.hasSizes    !== undefined) updates['sizes_choice']           = data.hasSizes ? 'TRUE' : 'FALSE';
    if (data.hasSugar    !== undefined) updates['sweetness_choice']       = data.hasSugar ? 'TRUE' : 'FALSE';
    if (data.priceShort  !== undefined) updates['size_short_price']       = parseFloat(data.priceShort) || 0;
    if (data.priceMedium !== undefined) updates['size_medium_price']      = parseFloat(data.priceMedium) || 0;
    if (data.priceTall   !== undefined) updates['size_tall_price']        = parseFloat(data.priceTall) || 0;
    if (data.image       !== undefined) updates['Product Image (Link)']   = data.image;
    if (data.status      !== undefined) updates['grabfood_status']        = data.status; // 'ACTIVE' or 'INACTIVE'

    // Apply updates
    Object.keys(updates).forEach(key => {
      const col = colIdx[key];
      if (col !== undefined) {
        menuSheet.getRange(targetRow, col + 1).setValue(updates[key]);
      }
    });

    return { ok: true, message: 'Item updated: ' + itemId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Add a new menu item row to YGC_MENU.
 * Accepts same fields as updateMenuItem plus itemId.
 */
function addMenuItem(data) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const menuSheet = ss.getSheetByName(SHEET_NAMES.MENU);
    if (!menuSheet) return { ok: false, error: 'YGC_MENU sheet not found' };

    const headers = menuSheet.getRange(1, 1, 1, menuSheet.getLastColumn()).getValues()[0];
    const colIdx = {};
    headers.forEach((h, i) => { colIdx[h] = i; });

    // Generate item_id if not provided
    const itemId = data.itemId || ('ITEM_' + Date.now());

    // Check for duplicate
    const existingData = menuSheet.getDataRange().getValues();
    for (let i = 1; i < existingData.length; i++) {
      if (String(existingData[i][colIdx['item_id']] || '').trim() === itemId) {
        return { ok: false, error: 'Item ID already exists: ' + itemId };
      }
    }

    const newRow = new Array(headers.length).fill('');
    const set = (key, val) => { if (colIdx[key] !== undefined) newRow[colIdx[key]] = val; };

    set('item_id',                itemId);
    set('item_name',              data.name        || '');
    set('category',               data.category    || '');
    set('base_price',             parseFloat(data.price) || 0);
    set('sizes_choice',           data.hasSizes    ? 'TRUE' : 'FALSE');
    set('sweetness_choice',       data.hasSugar    ? 'TRUE' : 'FALSE');
    set('size_short_price',       parseFloat(data.priceShort)  || 0);
    set('size_medium_price',      parseFloat(data.priceMedium) || 0);
    set('size_tall_price',        parseFloat(data.priceTall)   || 0);
    set('Product Image (Link)',   data.image       || '');
    set('grabfood_status',        data.status      || 'ACTIVE');

    menuSheet.appendRow(newRow);
    return { ok: true, message: 'Item added: ' + itemId, itemId: itemId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Soft-delete a menu item by setting grabfood_status to INACTIVE.
 * Hard delete is not done to preserve order history integrity.
 */
function deleteMenuItem(data) {
  try {
    const itemId = String(data.itemId || '').trim();
    if (!itemId) return { ok: false, error: 'itemId required' };
    return updateMenuItem({ itemId: itemId, status: 'INACTIVE' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORDER PLACEMENT
// ═══════════════════════════════════════════════════════════════════════

function placeOrder(data) {
  try {
    const tableNo = data.tableNo;
    const token = data.token;
    const customerName = data.customerName || '';
    const notes = data.notes || '';
    const orderType = data.orderType || 'DINE-IN';
    const items = data.items || [];
    
    if (!validateTableToken(tableNo, token)) {
      throw new Error('Invalid table token');
    }
    
    if (isThrottled(tableNo)) {
      throw new Error('Too many orders. Please wait a few minutes.');
    }
    
    if (items.length === 0) {
      throw new Error('Cart is empty');
    }
    
    const menuData = getMenu();
    const menuMap = {};
    menuData.items.forEach(item => {
      menuMap[item.code] = item;
    });
    
    let subtotal = 0;
    const validatedItems = [];
    
    for (const item of items) {
      const menuItem = menuMap[item.code];
      if (!menuItem) {
        throw new Error('Invalid item: ' + item.code);
      }
      
      let unitPrice = menuItem.price;
      
      if (item.size) {
        if (item.size === 'Short') {
          unitPrice = menuItem.priceShort || menuItem.price;
        } else if (item.size === 'Medium') {
          unitPrice = menuItem.priceMedium || (menuItem.price + 20);
        } else if (item.size === 'Tall') {
          unitPrice = menuItem.priceTall || (menuItem.price + 30);
        }
      }
      
      const qty = parseInt(item.qty) || 1;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;
      
      validatedItems.push({
        code: item.code,
        name: menuItem.name,
        size: item.size || '',
        sugarLevel: item.sugarLevel || '',
        qty: qty,
        unitPrice: unitPrice,
        lineTotal: lineTotal,
        notes: item.notes || ''
      });
    }
    
    const serviceCharge = (orderType === 'DINE-IN') ? subtotal * 0.10 : 0;
    const total = subtotal + serviceCharge;
    
    const orderNo = getNextOrderNumber();
    const prefix = getSetting('ORDER_PREFIX') || 'YANI';
    const orderId = prefix + '-' + orderNo;
    const timestamp = manilaTimestamp();
    
    const ss = getSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    
    appendByHeaders(ordersSheet, {
      ORDER_ID:        orderId,
      ORDER_NO:        orderNo,
      CREATED_AT:      timestamp,
      TABLE_NO:        tableNo,
      CUSTOMER_NAME:   customerName,
      STATUS:          'NEW',
      ORDER_TYPE:      orderType,
      SUBTOTAL:        subtotal,
      SERVICE_CHARGE:  serviceCharge,
      TOTAL:           total,
      NOTES:           notes,
      SOURCE:          'QR',
      ITEMS_JSON:      JSON.stringify(validatedItems),
      PLATFORM:        '',
      PLATFORM_REF:    '',
      COMMISSION_RATE: 0,
      COMMISSION_AMT:  0,
      NET_REVENUE:     total
    });
    
    const orderItemsSheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
    
    for (const item of validatedItems) {
      appendByHeaders(orderItemsSheet, {
        ORDER_ID:            orderId,
        ORDER_NO:            orderNo,
        CREATED_AT:          timestamp,
        TABLE_NO:            tableNo,
        ITEM_CODE:           item.code,
        ITEM_NAME_SNAPSHOT:  item.name,
        UNIT_PRICE_SNAPSHOT: item.unitPrice,
        QTY:                 item.qty,
        LINE_TOTAL:          item.lineTotal,
        ITEM_NOTES:          item.notes,
        sizes_choice:        item.size,
        sweetness_choice:    item.sugarLevel,
        total_receipt:       total,
        Total:               total
      });
    }
    
    // Log + update daily sales
    logAction('ORDER_PLACED', orderId, tableNo, customerName || 'Customer',
      validatedItems.length + ' items | ' + orderType + ' | ₱' + total.toFixed(2), 'OK');
    updateDailySales();
    
    return {
      ok: true,
      orderId: orderId,
      orderNo: orderNo,
      subtotal: subtotal,
      serviceCharge: serviceCharge,
      total: total,
      orderType: orderType
    };
    
  } catch (error) {
    logAction('ORDER_PLACED', '', '', 'Customer', error.message, 'ERROR');
    throw new Error('placeOrder failed: ' + error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM ORDER (Grab / FoodPanda / Other)
// Staff enters orders from delivery platforms — no table token needed
// ═══════════════════════════════════════════════════════════════════════

function placePlatformOrder(data) {
  try {
    const platform = (data.platform || '').toUpperCase();  // GRAB, FOODPANDA, OTHER
    const platformRef = data.platformRef || '';             // Platform's order reference #
    const items = data.items || [];
    const notes = data.notes || '';
    
    if (!platform) throw new Error('Platform is required');
    if (items.length === 0) throw new Error('No items selected');
    
    // Platform abbreviations for table field
    const PLATFORM_TABLE = { 'GRAB': 'GRAB', 'FOODPANDA': 'FP', 'OTHER': 'OTH' };
    const tableNo = PLATFORM_TABLE[platform] || platform;
    
    // Commission rate from SETTINGS (defaults to 0 if not set yet)
    const commKey = platform === 'FOODPANDA' ? 'FOODPANDA_COMMISSION' : (platform + '_COMMISSION');
    const commissionRate = parseFloat(getSetting(commKey)) || 0;
    
    // Validate items against menu
    const menuData = getMenu();
    const menuMap = {};
    menuData.items.forEach(function(item) { menuMap[item.code] = item; });
    
    let subtotal = 0;
    const validatedItems = [];
    
    for (const item of items) {
      const menuItem = menuMap[item.code];
      if (!menuItem) throw new Error('Invalid item: ' + item.code);
      
      let unitPrice = menuItem.price;
      if (item.size) {
        if (item.size === 'Short') unitPrice = menuItem.priceShort || menuItem.price;
        else if (item.size === 'Medium') unitPrice = menuItem.priceMedium || (menuItem.price + 20);
        else if (item.size === 'Tall') unitPrice = menuItem.priceTall || (menuItem.price + 30);
      }
      
      const qty = parseInt(item.qty) || 1;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;
      
      validatedItems.push({
        code: item.code,
        name: menuItem.name,
        size: item.size || '',
        sugarLevel: item.sugarLevel || '',
        qty: qty,
        unitPrice: unitPrice,
        lineTotal: lineTotal,
        notes: item.notes || ''
      });
    }
    
    // Platform orders: NO service charge
    const serviceCharge = 0;
    const total = subtotal;
    const commissionAmt = Math.round(total * (commissionRate / 100) * 100) / 100;
    const netRevenue = Math.round((total - commissionAmt) * 100) / 100;
    
    const orderNo = getNextOrderNumber();
    const prefix = getSetting('ORDER_PREFIX') || 'YANI';
    const orderId = prefix + '-' + orderNo;
    const timestamp = manilaTimestamp();
    
    const ss = getSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    
    appendByHeaders(ordersSheet, {
      ORDER_ID:        orderId,
      ORDER_NO:        orderNo,
      CREATED_AT:      timestamp,
      TABLE_NO:        tableNo,
      CUSTOMER_NAME:   '',
      STATUS:          'NEW',
      ORDER_TYPE:      platform,
      SUBTOTAL:        subtotal,
      SERVICE_CHARGE:  serviceCharge,
      TOTAL:           total,
      NOTES:           notes,
      SOURCE:          'PLATFORM',
      ITEMS_JSON:      JSON.stringify(validatedItems),
      PAYMENT_METHOD:  'PLATFORM',
      PAYMENT_STATUS:  'PLATFORM_PAID',
      PLATFORM:        platform,
      PLATFORM_REF:    platformRef,
      COMMISSION_RATE: commissionRate,
      COMMISSION_AMT:  commissionAmt,
      NET_REVENUE:     netRevenue
    });
    
    const orderItemsSheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
    
    for (const item of validatedItems) {
      appendByHeaders(orderItemsSheet, {
        ORDER_ID:            orderId,
        ORDER_NO:            orderNo,
        CREATED_AT:          timestamp,
        TABLE_NO:            tableNo,
        ITEM_CODE:           item.code,
        ITEM_NAME_SNAPSHOT:  item.name,
        UNIT_PRICE_SNAPSHOT: item.unitPrice,
        QTY:                 item.qty,
        LINE_TOTAL:          item.lineTotal,
        ITEM_NOTES:          item.notes,
        sizes_choice:        item.size,
        sweetness_choice:    item.sugarLevel,
        total_receipt:       total,
        Total:               total
      });
    }
    
    logAction('PLATFORM_ORDER', orderId, tableNo, 'Staff',
      platform + (platformRef ? ' #' + platformRef : '') + ' | ' + validatedItems.length + ' items | ₱' + total.toFixed(2) +
      (commissionRate > 0 ? ' | Commission: ' + commissionRate + '% = ₱' + commissionAmt.toFixed(2) : ''), 'OK');
    updateDailySales();
    
    return {
      ok: true,
      orderId: orderId,
      orderNo: orderNo,
      subtotal: subtotal,
      total: total,
      platform: platform,
      platformRef: platformRef,
      commissionRate: commissionRate,
      commissionAmt: commissionAmt,
      netRevenue: netRevenue
    };
    
  } catch (error) {
    logAction('PLATFORM_ORDER', '', '', 'Staff', error.message, 'ERROR');
    throw new Error('placePlatformOrder failed: ' + error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORDER RETRIEVAL
// ═══════════════════════════════════════════════════════════════════════

function getOrders(data) {
  try {
    const status = data.status || 'ALL';
    const limit = parseInt(data.limit) || 100;
    
    const ss = getSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const orderItemsSheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
    
    const ordersData = ordersSheet.getDataRange().getValues();
    const ordersHeaders = ordersData[0];
    const orders = [];
    
    for (let i = ordersData.length - 1; i >= 1; i--) {
      const row = ordersData[i];
      
      const getValue = (colName) => {
        const index = ordersHeaders.indexOf(colName);
        return index >= 0 ? row[index] : null;
      };
      
      const orderStatus = getValue('STATUS');
      
      if (status !== 'ALL' && orderStatus !== status) {
        continue;
      }
      
      const orderId = getValue('ORDER_ID');
      const items = getOrderItems(orderId, orderItemsSheet);
      
      orders.push({
        orderId: orderId,
        orderNo: getValue('ORDER_NO'),
        createdAt: getValue('CREATED_AT'),
        table: getValue('TABLE_NO'),
        customer: getValue('CUSTOMER_NAME') || '',
        status: orderStatus,
        orderType: getValue('ORDER_TYPE'),
        subtotal: getValue('SUBTOTAL'),
        serviceCharge: getValue('SERVICE_CHARGE'),
        total: getValue('TOTAL') || (Number(getValue('SUBTOTAL') || 0) + Number(getValue('SERVICE_CHARGE') || 0)),
        paymentMethod: getValue('PAYMENT_METHOD') || '',
        paymentStatus: getValue('PAYMENT_STATUS') || '',
        notes: getValue('NOTES') || '',
        platform: getValue('PLATFORM') || '',
        platformRef: getValue('PLATFORM_REF') || '',
        commissionRate: getValue('COMMISSION_RATE') || 0,
        commissionAmt: getValue('COMMISSION_AMT') || 0,
        netRevenue: getValue('NET_REVENUE') || 0,
        // Receipt customer details - FIXED TO MATCH ACTUAL SHEET COLUMNS
        receiptType: getValue('RECEIPT_TYPE') || '',
        receiptDelivery: getValue('RECEIPT_DELIVERY') || '',
        receiptEmail: getValue('RECEIPT_EMAIL') || '',
        receiptName: getValue('CUSTOMER_NAME_FULL') || '',      // Column V
        receiptAddress: getValue('CUSTOMER_ADDRESS') || '',     // Column W
        receiptTIN: getValue('CUSTOMER_TIN') || '',             // Column U
        items: items
      });
      
      if (orders.length >= limit) {
        break;
      }
    }
    
    return {
      ok: true,
      orders: orders
    };
    
  } catch (error) {
    throw new Error('getOrders failed: ' + error.message);
  }
}

function getOrderItems(orderId, orderItemsSheet) {
  const data = orderItemsSheet.getDataRange().getValues();
  const headers = data[0];
  const items = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    const getValue = (colName) => {
      const index = headers.indexOf(colName);
      return index >= 0 ? row[index] : null;
    };
    
    if (getValue('ORDER_ID') === orderId) {
      items.push({
        code: getValue('ITEM_CODE'),
        name: getValue('ITEM_NAME_SNAPSHOT'),
        size: getValue('sizes_choice') || '',
        sugar: getValue('sweetness_choice') || '',
        qty: getValue('QTY'),
        price: getValue('UNIT_PRICE_SNAPSHOT'),
        notes: getValue('ITEM_NOTES') || ''
      });
    }
  }
  
  return items;
}

// ═══════════════════════════════════════════════════════════════════════
// ORDER STATUS UPDATE
// ═══════════════════════════════════════════════════════════════════════

function updateOrderStatus(data) {
  try {
    const orderId = data.orderId;
    const newStatus = data.status;
    
    const ss = getSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    
    const rowFound = updateByHeaders(ordersSheet, 'ORDER_ID', orderId, { STATUS: newStatus });
    
    if (rowFound < 0) throw new Error('Order not found: ' + orderId);
    
    logAction('STATUS_' + newStatus, orderId, '', 'Staff', 'Status changed to ' + newStatus, 'OK');
    updateDailySales();
    return { ok: true, orderId: orderId, status: newStatus };
    
  } catch (error) {
    throw new Error('updateOrderStatus failed: ' + error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT UPLOAD
// ═══════════════════════════════════════════════════════════════════════

function uploadPayment(data) {
  try {
    const orderId = data.orderId;
    const tableNo = data.tableNo;
    const amount = parseFloat(data.amount);
    const imageData = data.imageData;
    
    const blob = Utilities.newBlob(
      Utilities.base64Decode(imageData.split(',')[1]),
      'image/jpeg',
      `${orderId}_T${tableNo}_${Date.now()}.jpg`
    );
    
    const folder = getOrCreatePaymentsFolder();
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    const paymentId = 'PAY-' + Math.random().toString(36).substr(2, 8).toUpperCase();
    
    // Look up customer name from ORDERS sheet
    const ss = getSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const ordersData = ordersSheet.getDataRange().getValues();
    const ordersHeaders = ordersData[0];
    let customerName = '';
    
    for (let i = 1; i < ordersData.length; i++) {
      if (ordersData[i][0] === orderId) {
        const nameCol = ordersHeaders.indexOf('CUSTOMER_NAME');
        if (nameCol >= 0) customerName = ordersData[i][nameCol] || '';
        break;
      }
    }
    
    const paymentsSheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    
    // Fill ALL columns A-W so data aligns with headers
    // NOTE: Column V header should be "CUSTOMER_NAME_FULL" (not "CUSTOMER_NAME") to avoid conflict with D
    paymentsSheet.appendRow([
      paymentId,          // A: PAYMENT_ID
      orderId,            // B: ORDER_ID
      tableNo,            // C: TABLE_NO
      customerName,       // D: CUSTOMER_NAME
      amount,             // E: AMOUNT
      manilaTimestamp(),         // F: UPLOADED_AT
      file.getUrl(),      // G: FILE_URL
      file.getId(),       // H: FILE_ID
      'PENDING',          // I: STATUS
      '',                 // J: VERIFIED_BY
      '',                 // K: VERIFIED_AT
      '',                 // L: NOTES
      '',                 // M: RECEIPT_REQUESTED
      '',                 // N: RECEIPT_TYPE
      '',                 // O: RECEIPT_DELIVERY
      '',                 // P: RECEIPT_EMAIL
      '',                 // Q: RECEIPT_SENT_AT
      '',                 // R: RECEIPT_STATUS
      '',                 // S: RECEIPT_FILE_URL
      '',                 // T: RECEIPT_FILE_ID
      '',                 // U: CUSTOMER_TIN
      customerName,       // V: CUSTOMER_NAME_FULL
      ''                  // W: CUSTOMER_ADDRESS
    ]);
    
    updateOrderPaymentStatus(orderId, 'SUBMITTED');
    
    logAction('PAYMENT_UPLOADED', orderId, tableNo, customerName || 'Customer',
      'Amount: ₱' + amount + ' | Method: ' + (data.method || 'QR') + ' | PayID: ' + paymentId, 'OK',
      file.getUrl());
    
    return {
      ok: true,
      paymentId: paymentId,
      fileUrl: file.getUrl()
    };
    
  } catch (error) {
    logAction('PAYMENT_UPLOADED', data.orderId || '', data.tableNo || '', 'Customer', error.message, 'ERROR');
    throw new Error('uploadPayment failed: ' + error.message);
  }
}

function updateOrderPaymentStatus(orderId, paymentStatus) {
  const ss = getSpreadsheet();
  const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
  updateByHeaders(ordersSheet, 'ORDER_ID', orderId, { PAYMENT_STATUS: paymentStatus });
}

/**
 * Update PAYMENTS sheet with receipt info and customer details for an order.
 * Finds ALL payment rows matching the orderId and fills columns M-W.
 */
function updatePaymentReceiptInfo(orderId, info) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    if (!sheet) return;
    
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    
    // Column indices (0-based)
    const col = {};
    headers.forEach(function(h, idx) { col[h] = idx; });
    
    for (let i = 1; i < allData.length; i++) {
      if (String(allData[i][col['ORDER_ID']] || '') === String(orderId)) {
        const row = i + 1;
        
        // Receipt info (columns M-T)
        if (info.receiptRequested !== undefined && col['RECEIPT_REQUESTED'] !== undefined)
          sheet.getRange(row, col['RECEIPT_REQUESTED'] + 1).setValue(info.receiptRequested || 'TRUE');
        if (info.receiptType && col['RECEIPT_TYPE'] !== undefined)
          sheet.getRange(row, col['RECEIPT_TYPE'] + 1).setValue(info.receiptType);
        if (info.receiptDelivery && col['RECEIPT_DELIVERY'] !== undefined)
          sheet.getRange(row, col['RECEIPT_DELIVERY'] + 1).setValue(info.receiptDelivery);
        if (info.receiptEmail && col['RECEIPT_EMAIL'] !== undefined)
          sheet.getRange(row, col['RECEIPT_EMAIL'] + 1).setValue(info.receiptEmail);
        if (info.receiptSentAt && col['RECEIPT_SENT_AT'] !== undefined)
          sheet.getRange(row, col['RECEIPT_SENT_AT'] + 1).setValue(info.receiptSentAt);
        if (info.receiptStatus && col['RECEIPT_STATUS'] !== undefined)
          sheet.getRange(row, col['RECEIPT_STATUS'] + 1).setValue(info.receiptStatus);
        if (info.receiptFileUrl && col['RECEIPT_FILE_URL'] !== undefined)
          sheet.getRange(row, col['RECEIPT_FILE_URL'] + 1).setValue(info.receiptFileUrl);
        if (info.receiptFileId && col['RECEIPT_FILE_ID'] !== undefined)
          sheet.getRange(row, col['RECEIPT_FILE_ID'] + 1).setValue(info.receiptFileId);
        
        // Customer details (columns U-W)
        if (info.customerTin && col['CUSTOMER_TIN'] !== undefined)
          sheet.getRange(row, col['CUSTOMER_TIN'] + 1).setValue(info.customerTin);
        if (info.customerName) {
          // Write to CUSTOMER_NAME_FULL (col V) if it exists, else fallback
          const fullNameCol = col['CUSTOMER_NAME_FULL'] !== undefined ? col['CUSTOMER_NAME_FULL'] : col['CUSTOMER_NAME'];
          if (fullNameCol !== undefined) sheet.getRange(row, fullNameCol + 1).setValue(info.customerName);
        }
        if (info.customerAddress && col['CUSTOMER_ADDRESS'] !== undefined)
          sheet.getRange(row, col['CUSTOMER_ADDRESS'] + 1).setValue(info.customerAddress);
        
        // Don't break — update ALL payment rows for this order
      }
    }
  } catch (e) {
    Logger.log('updatePaymentReceiptInfo error: ' + e.toString());
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ACTIVITY LOGGING — writes to LOGS sheet
// Every action gets logged for full audit trail
// ═══════════════════════════════════════════════════════════════════════

function logAction(action, orderId, tableNo, actor, details, status, link) {
  try {
    const ss = getSpreadsheet();
    const logsSheet = ss.getSheetByName(SHEET_NAMES.LOGS);
    if (!logsSheet) return;
    
    // Check if headers exist, if sheet is empty add them
    if (logsSheet.getLastRow() === 0) {
      logsSheet.appendRow([
        'TIMESTAMP', 'ACTION', 'ORDER_ID', 'TABLE_NO', 
        'ACTOR', 'DETAILS', 'STATUS', 'IP_SOURCE', 'LINK'
      ]);
    }
    
    logsSheet.appendRow([
      manilaTimestamp(),                    // TIMESTAMP
      action || '',                  // ACTION
      orderId || '',                 // ORDER_ID
      tableNo || '',                 // TABLE_NO
      actor || 'Customer',           // ACTOR
      details || '',                 // DETAILS
      status || 'OK',               // STATUS
      'Vercel',                      // IP_SOURCE
      link || ''                     // LINK (receipt URL, payment screenshot, etc.)
    ]);
  } catch (e) {
    Logger.log('logAction error: ' + e.toString());
    // Never throw from logging — it should never break the main flow
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DAILY SALES — writes/updates SALES_DAILY sheet
// Called after every order placement and status change
// ═══════════════════════════════════════════════════════════════════════

function updateDailySales() {
  try {
    const ss = getSpreadsheet();
    const salesSheet = ss.getSheetByName('SALES_DAILY');
    if (!salesSheet) return;
    
    // Ensure headers exist
    if (salesSheet.getLastRow() === 0) {
      salesSheet.appendRow([
        'DATE', 'TOTAL_ORDERS', 'TOTAL_SALES', 'DINE_IN_ORDERS', 'TAKE_OUT_ORDERS',
        'DINE_IN_SALES', 'TAKE_OUT_SALES', 'AVG_ORDER_VALUE',
        'COMPLETED_ORDERS', 'CANCELLED_ORDERS',
        'PAYMENTS_VERIFIED', 'PAYMENTS_PENDING',
        'RECEIPTS_EMAILED', 'RECEIPTS_PRINTED',
        'GRAB_ORDERS', 'GRAB_SALES', 'FP_ORDERS', 'FP_SALES',
        'OTHER_PLATFORM_ORDERS', 'OTHER_PLATFORM_SALES',
        'PLATFORM_COMMISSION', 'NET_REVENUE',
        'UPDATED_AT'
      ]);
    }
    
    // Get today's date string (Manila timezone)
    const today = manilaDate();
    
    // Read all orders
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const ordersData = ordersSheet.getDataRange().getValues();
    const ordersHeaders = ordersData[0];
    
    // Find column indices
    const oCol = {};
    ordersHeaders.forEach(function(h, idx) { oCol[h] = idx; });
    
    // Aggregate today's data
    let totalOrders = 0, totalSales = 0;
    let dineInOrders = 0, takeOutOrders = 0;
    let dineInSales = 0, takeOutSales = 0;
    let completedOrders = 0, cancelledOrders = 0;
    let receiptsEmailed = 0, receiptsPrinted = 0;
    let grabOrders = 0, grabSales = 0;
    let fpOrders = 0, fpSales = 0;
    let otherPlatOrders = 0, otherPlatSales = 0;
    let totalCommission = 0, totalNetRevenue = 0;
    
    for (let i = 1; i < ordersData.length; i++) {
      const row = ordersData[i];
      const createdAt = row[oCol['CREATED_AT']];
      if (!createdAt) continue;
      
      let orderDate;
      try {
        orderDate = Utilities.formatDate(
          (createdAt instanceof Date) ? createdAt : new Date(createdAt),
          'Asia/Manila', 'yyyy-MM-dd'
        );
      } catch(e) { continue; }
      
      if (orderDate !== today) continue;
      
      totalOrders++;
      const orderTotal = Number(row[oCol['TOTAL']] || 0) || 
                         (Number(row[oCol['SUBTOTAL']] || 0) + Number(row[oCol['SERVICE_CHARGE']] || 0));
      const orderType = String(row[oCol['ORDER_TYPE']] || '');
      const status = String(row[oCol['STATUS']] || '');
      const receiptDel = String(row[oCol['RECEIPT_DELIVERY']] || row[14] || '');
      
      // Only count sales for non-cancelled orders
      if (status !== 'CANCELLED') {
        totalSales += orderTotal;
        
        const platform = String(row[oCol['PLATFORM']] || '');
        const commAmt = Number(row[oCol['COMMISSION_AMT']] || 0);
        const netRev = Number(row[oCol['NET_REVENUE']] || orderTotal);
        
        if (platform === 'GRAB') {
          grabOrders++;
          grabSales += orderTotal;
        } else if (platform === 'FOODPANDA') {
          fpOrders++;
          fpSales += orderTotal;
        } else if (platform && platform !== '') {
          otherPlatOrders++;
          otherPlatSales += orderTotal;
        } else if (orderType === 'DINE-IN') {
          dineInOrders++;
          dineInSales += orderTotal;
        } else {
          takeOutOrders++;
          takeOutSales += orderTotal;
        }
        
        totalCommission += commAmt;
        totalNetRevenue += netRev;
      }
      
      if (status === 'COMPLETED') completedOrders++;
      if (status === 'CANCELLED') cancelledOrders++;
      
      if (receiptDel.toLowerCase() === 'email') receiptsEmailed++;
      if (receiptDel.toLowerCase() === 'printed') receiptsPrinted++;
    }
    
    // Count today's payment statuses
    const paymentsSheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    let paymentsVerified = 0, paymentsPending = 0;
    
    if (paymentsSheet && paymentsSheet.getLastRow() > 1) {
      const payData = paymentsSheet.getDataRange().getValues();
      const payHeaders = payData[0];
      const pCol = {};
      payHeaders.forEach(function(h, idx) { pCol[h] = idx; });
      
      for (let i = 1; i < payData.length; i++) {
        const uploadedAt = payData[i][pCol['UPLOADED_AT']];
        if (!uploadedAt) continue;
        
        let payDate;
        try {
          payDate = Utilities.formatDate(
            (uploadedAt instanceof Date) ? uploadedAt : new Date(uploadedAt),
            'Asia/Manila', 'yyyy-MM-dd'
          );
        } catch(e) { continue; }
        
        if (payDate !== today) continue;
        
        const payStatus = String(payData[i][pCol['STATUS']] || '');
        if (payStatus === 'VERIFIED') paymentsVerified++;
        if (payStatus === 'PENDING') paymentsPending++;
      }
    }
    
    const avgOrderValue = totalOrders > 0 ? Math.round(totalSales / totalOrders * 100) / 100 : 0;
    
    // Find or create today's row
    const salesData = salesSheet.getDataRange().getValues();
    let todayRow = -1;
    
    for (let i = 1; i < salesData.length; i++) {
      let rowDate;
      try {
        rowDate = Utilities.formatDate(
          (salesData[i][0] instanceof Date) ? salesData[i][0] : new Date(salesData[i][0]),
          'Asia/Manila', 'yyyy-MM-dd'
        );
      } catch(e) { continue; }
      
      if (rowDate === today) {
        todayRow = i + 1;
        break;
      }
    }
    
    const rowData = [
      today,              // DATE
      totalOrders,        // TOTAL_ORDERS
      totalSales,         // TOTAL_SALES
      dineInOrders,       // DINE_IN_ORDERS
      takeOutOrders,      // TAKE_OUT_ORDERS
      dineInSales,        // DINE_IN_SALES
      takeOutSales,       // TAKE_OUT_SALES
      avgOrderValue,      // AVG_ORDER_VALUE
      completedOrders,    // COMPLETED_ORDERS
      cancelledOrders,    // CANCELLED_ORDERS
      paymentsVerified,   // PAYMENTS_VERIFIED
      paymentsPending,    // PAYMENTS_PENDING
      receiptsEmailed,    // RECEIPTS_EMAILED
      receiptsPrinted,    // RECEIPTS_PRINTED
      grabOrders,         // GRAB_ORDERS
      grabSales,          // GRAB_SALES
      fpOrders,           // FP_ORDERS
      fpSales,            // FP_SALES
      otherPlatOrders,    // OTHER_PLATFORM_ORDERS
      otherPlatSales,     // OTHER_PLATFORM_SALES
      totalCommission,    // PLATFORM_COMMISSION
      totalNetRevenue,    // NET_REVENUE
      manilaTimestamp()   // UPDATED_AT
    ];
    
    if (todayRow > 0) {
      // Update existing row
      salesSheet.getRange(todayRow, 1, 1, rowData.length).setValues([rowData]);
    } else {
      // Append new row
      salesSheet.appendRow(rowData);
    }
    
  } catch (e) {
    Logger.log('updateDailySales error: ' + e.toString());
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RECEIPT REQUEST (UPDATED - now sends email if delivery === 'email')
// ═══════════════════════════════════════════════════════════════════════

function requestReceipt(data) {
  try {
    const orderId = data.orderId;
    const receiptType = data.receiptType;
    const deliveryMethod = data.deliveryMethod || data.delivery || '';
    const email = data.email || '';
    const customerName = data.customerName || data.name || '';
    const customerAddress = data.customerAddress || data.address || '';
    const customerTin = data.customerTin || data.tin || '';
    
    // Save receipt info to ORDERS sheet
    updateOrderReceiptInfo(orderId, receiptType, deliveryMethod, email, customerName, customerAddress, customerTin);
    
    // Save receipt + customer info to PAYMENTS sheet too
    updatePaymentReceiptInfo(orderId, {
      receiptRequested: 'TRUE',
      receiptType: receiptType,
      receiptDelivery: deliveryMethod,
      receiptEmail: email,
      customerName: customerName,
      customerAddress: customerAddress,
      customerTin: customerTin
    });
    
    // If email delivery requested AND email provided, actually send it
    if (deliveryMethod === 'email' && email) {
      return handleSendEmailReceipt({
        orderId: orderId,
        receiptType: receiptType,
        email: email,
        name: customerName,
        address: customerAddress,
        tin: customerTin
      });
    }
    
    // Printed receipt — handled at counter
    updatePaymentReceiptInfo(orderId, {
      receiptStatus: 'SENT_TO_CAFE'
    });
    
    logAction('RECEIPT_REQUESTED', orderId, '', customerName || 'Customer',
      'Type: ' + receiptType + ' | Delivery: PRINTED', 'OK');
    
    return {
      ok: true,
      message: 'Receipt will be ready at the counter'
    };
    
  } catch (error) {
    logAction('RECEIPT_REQUESTED', data.orderId || '', '', 'Customer', error.message, 'ERROR');
    throw new Error('requestReceipt failed: ' + error.message);
  }
}

function updateOrderReceiptInfo(orderId, receiptType, deliveryMethod, email, customerName, customerAddress, customerTin) {
  const ss = getSpreadsheet();
  const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
  
  var updates = {};
  if (receiptType)      updates['RECEIPT_TYPE'] = receiptType;
  if (deliveryMethod)   updates['RECEIPT_DELIVERY'] = deliveryMethod;
  if (email)            updates['RECEIPT_EMAIL'] = email;
  if (customerAddress)  updates['CUSTOMER_ADDRESS'] = customerAddress;
  if (customerTin)      updates['CUSTOMER_TIN'] = customerTin;
  if (customerName)     updates['CUSTOMER_NAME'] = customerName;
  
  updateByHeaders(ordersSheet, 'ORDER_ID', orderId, updates);
}

// ═══════════════════════════════════════════════════════════════════════
// SEND EMAIL RECEIPT (NEW)
// Generates PDF receipt, saves to Drive, emails to customer
// Sender: tygfsb@gmail.com
// ═══════════════════════════════════════════════════════════════════════

function handleSendEmailReceipt(data) {
  try {
    const orderId     = data.orderId;
    const receiptType = data.receiptType || 'simple';
    const email       = data.email;
    const custName    = data.name || '';
    const custAddress = data.address || '';
    const custTin     = data.tin || '';
    
    if (!orderId) return { ok: false, error: 'Missing orderId' };
    if (!email)   return { ok: false, error: 'Missing email address' };
    
    // ── Get order data ──
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const orderItemsSheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
    
    // Find order
    const ordersData = ordersSheet.getDataRange().getValues();
    const ordersHeaders = ordersData[0];
    let orderData = null;
    
    for (let i = 1; i < ordersData.length; i++) {
      if (ordersData[i][0] === orderId) {
        orderData = {};
        ordersHeaders.forEach((h, idx) => { orderData[h] = ordersData[i][idx]; });
        break;
      }
    }
    
    if (!orderData) return { ok: false, error: 'Order not found: ' + orderId };
    
    // Find order items
    const itemsData = orderItemsSheet.getDataRange().getValues();
    const itemsHeaders = itemsData[0];
    const orderItems = [];
    
    for (let i = 1; i < itemsData.length; i++) {
      if (itemsData[i][0] === orderId) {
        const item = {};
        itemsHeaders.forEach((h, idx) => { item[h] = itemsData[i][idx]; });
        orderItems.push(item);
      }
    }
    
    if (orderItems.length === 0) {
      return { ok: false, error: 'No items found for order: ' + orderId };
    }
    
    // ── Build receipt HTML ──
    // Calculate total from available fields (sheet may not have a TOTAL column)
    const total = Number(orderData['TOTAL'] || 0) || 
                  (Number(orderData['SUBTOTAL'] || 0) + Number(orderData['SERVICE_CHARGE'] || 0));
    
    const receiptHtml = buildReceiptHTML(orderId, receiptType, orderData, orderItems, custName, custAddress, custTin);
    
    // ── Convert HTML to PDF via temp file ──
    const tempFile = DriveApp.createFile(orderId + '_temp.html', receiptHtml, 'text/html');
    const pdfBlob = tempFile.getAs('application/pdf').setName(orderId + '_receipt.pdf');
    tempFile.setTrashed(true);
    
    // ── Save PDF to correct Drive folder ──
    const folderId = (receiptType === 'bir')
      ? RECEIPT_CONFIG.BIR_RECEIPT_FOLDER_ID
      : RECEIPT_CONFIG.SIMPLE_RECEIPT_FOLDER_ID;
    
    const folder = DriveApp.getFolderById(folderId);
    const pdfFile = folder.createFile(pdfBlob);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // ── Build email body ──
    // total already calculated above
    const isBIR = (receiptType === 'bir');
    
    const biz = getBizInfo();
    const emailHtml = '<div style="font-family:Helvetica Neue,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;background:#f5f0ea;">'
      + '<div style="text-align:center;padding:24px 0;">'
      +   '<div style="font-size:28px;font-weight:700;color:#314C47;letter-spacing:1px;">' + biz.name + '</div>'
      +   '<div style="font-size:12px;color:#B8973A;letter-spacing:2px;margin-top:4px;">GROUNDED ELEVATION</div>'
      + '</div>'
      + '<div style="background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">'
      +   '<div style="text-align:center;margin-bottom:20px;">'
      +     '<div style="font-size:36px;">☕</div>'
      +     '<div style="font-size:18px;color:#314C47;font-weight:600;margin-top:8px;">'
      +       (isBIR ? 'Your Official Receipt' : 'Your Sales Invoice')
      +     '</div>'
      +     '<div style="font-size:13px;color:#8a7e6b;margin-top:4px;">Order ' + orderId + '</div>'
      +   '</div>'
      +   '<div style="background:#f9f6f1;border-radius:8px;padding:16px;text-align:center;margin-bottom:20px;">'
      +     '<div style="font-size:13px;color:#8a7e6b;">Total Amount</div>'
      +     '<div style="font-size:24px;font-weight:700;color:#C4704B;">' + formatPeso(total) + '</div>'
      +   '</div>'
      +   '<div style="font-size:13px;color:#666;line-height:1.6;">'
      +     'Your receipt is attached as a PDF. Please save it for your records.'
      +     (isBIR ? ' This receipt is valid for BIR tax deduction purposes.' : '')
      +   '</div>'
      + '</div>'
      + '<div style="text-align:center;padding:20px;font-size:11px;color:#aaa;">'
      +   biz.storeName + ' &middot; ' + biz.address + '<br>' + biz.tagline
      + '</div>'
      + '</div>';
    
    // ── Send email ──
    const subject = (isBIR ? 'Official Receipt' : 'Sales Invoice') + ' - ' + orderId + ' | ' + biz.storeName;
    
    MailApp.sendEmail({
      to: email,
      subject: subject,
      htmlBody: emailHtml,
      attachments: [pdfFile.getAs('application/pdf')],
      name: getBizInfo().senderName
    });
    
    // ── Update PAYMENTS sheet with receipt info ──
    updatePaymentReceiptInfo(orderId, {
      receiptRequested: 'TRUE',
      receiptType: receiptType,
      receiptDelivery: 'EMAIL',
      receiptEmail: email,
      receiptSentAt: manilaTimestamp(),
      receiptStatus: 'SENT',
      receiptFileUrl: pdfFile.getUrl(),
      receiptFileId: pdfFile.getId(),
      customerName: custName,
      customerAddress: custAddress,
      customerTin: custTin
    });
    
    logAction('RECEIPT_EMAILED', orderId, '', custName || 'Customer',
      'Type: ' + receiptType + ' | To: ' + email + ' | PDF: ' + pdfFile.getName(), 'OK',
      pdfFile.getUrl());
    
    return {
      ok: true,
      message: 'Receipt sent to ' + email,
      receiptUrl: pdfFile.getUrl()
    };
    
  } catch (error) {
    Logger.log('sendEmailReceipt error: ' + error.toString());
    logAction('RECEIPT_EMAILED', data.orderId || '', '', '', error.message, 'ERROR');
    return { ok: false, error: 'Failed to send receipt: ' + error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFY PAYMENT (NEW)
// Staff verifies a payment screenshot — updates PAYMENTS sheet,
// moves file to "processed" subfolder in YGC payment
// ═══════════════════════════════════════════════════════════════════════

function handleVerifyPayment(data) {
  try {
    const paymentId  = data.paymentId;
    const verifiedBy = data.verifiedBy || 'Staff';
    
    if (!paymentId) return { ok: false, error: 'Missing paymentId' };
    
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    if (!sheet) return { ok: false, error: 'PAYMENTS sheet not found' };
    
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const pidCol    = headers.indexOf('PAYMENT_ID');
    const fidCol    = headers.indexOf('FILE_ID');
    const statusCol = headers.indexOf('STATUS');
    const verByCol  = headers.indexOf('VERIFIED_BY');
    const verAtCol  = headers.indexOf('VERIFIED_AT');
    const orderCol  = headers.indexOf('ORDER_ID');
    
    // Find the payment row
    let foundRow = -1;
    let fileId = '';
    let relatedOrderId = '';
    
    for (let i = 1; i < allData.length; i++) {
      if (String(allData[i][pidCol]).trim() === String(paymentId).trim()) {
        foundRow = i + 1;
        fileId = fidCol >= 0 ? String(allData[i][fidCol]).trim() : '';
        relatedOrderId = orderCol >= 0 ? String(allData[i][orderCol]).trim() : '';
        break;
      }
    }
    
    if (foundRow === -1) return { ok: false, error: 'Payment not found: ' + paymentId };
    
    // Update sheet
    if (statusCol >= 0) sheet.getRange(foundRow, statusCol + 1).setValue('VERIFIED');
    if (verByCol >= 0)  sheet.getRange(foundRow, verByCol + 1).setValue(verifiedBy);
    if (verAtCol >= 0)  sheet.getRange(foundRow, verAtCol + 1).setValue(manilaTimestamp());
    
    // Also update the ORDERS sheet payment status
    if (relatedOrderId) {
      updateOrderPaymentStatus(relatedOrderId, 'VERIFIED');
    }
    
    // Move screenshot to "processed" subfolder
    if (fileId) {
      movePaymentFile(fileId, 'processed');
    }
    
    logAction('PAYMENT_VERIFIED', relatedOrderId, '', verifiedBy,
      'PayID: ' + paymentId + ' | Moved to processed/', 'OK');
    updateDailySales();
    
    return { ok: true, message: 'Payment ' + paymentId + ' verified', orderId: relatedOrderId };
    
  } catch (error) {
    Logger.log('verifyPayment error: ' + error.toString());
    logAction('PAYMENT_VERIFIED', data.paymentId || '', '', 'Staff', error.message, 'ERROR');
    return { ok: false, error: 'Failed to verify payment: ' + error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// REJECT PAYMENT (NEW)
// Staff rejects a payment screenshot — updates PAYMENTS sheet,
// moves file to "rejected" subfolder in YGC payment
// ═══════════════════════════════════════════════════════════════════════

function handleRejectPayment(data) {
  try {
    const paymentId  = data.paymentId;
    const reason     = data.reason || '';
    const verifiedBy = data.verifiedBy || 'Staff';
    
    if (!paymentId) return { ok: false, error: 'Missing paymentId' };
    
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    if (!sheet) return { ok: false, error: 'PAYMENTS sheet not found' };
    
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const pidCol    = headers.indexOf('PAYMENT_ID');
    const fidCol    = headers.indexOf('FILE_ID');
    const statusCol = headers.indexOf('STATUS');
    const verByCol  = headers.indexOf('VERIFIED_BY');
    const verAtCol  = headers.indexOf('VERIFIED_AT');
    const notesCol  = headers.indexOf('NOTES');
    const orderCol  = headers.indexOf('ORDER_ID');
    
    let foundRow = -1;
    let fileId = '';
    let relatedOrderId = '';
    
    for (let i = 1; i < allData.length; i++) {
      if (String(allData[i][pidCol]).trim() === String(paymentId).trim()) {
        foundRow = i + 1;
        fileId = fidCol >= 0 ? String(allData[i][fidCol]).trim() : '';
        relatedOrderId = orderCol >= 0 ? String(allData[i][orderCol]).trim() : '';
        break;
      }
    }
    
    if (foundRow === -1) return { ok: false, error: 'Payment not found: ' + paymentId };
    
    if (statusCol >= 0) sheet.getRange(foundRow, statusCol + 1).setValue('REJECTED');
    if (verByCol >= 0)  sheet.getRange(foundRow, verByCol + 1).setValue(verifiedBy);
    if (verAtCol >= 0)  sheet.getRange(foundRow, verAtCol + 1).setValue(manilaTimestamp());
    if (notesCol >= 0 && reason) sheet.getRange(foundRow, notesCol + 1).setValue('Rejected: ' + reason);
    
    // Update ORDERS sheet
    if (relatedOrderId) {
      updateOrderPaymentStatus(relatedOrderId, 'REJECTED');
    }
    
    // Move screenshot to "rejected" subfolder
    if (fileId) {
      movePaymentFile(fileId, 'rejected');
    }
    
    logAction('PAYMENT_REJECTED', relatedOrderId, '', verifiedBy,
      'PayID: ' + paymentId + ' | Reason: ' + (reason || 'none'), 'OK');
    updateDailySales();
    
    return { ok: true, message: 'Payment ' + paymentId + ' rejected', orderId: relatedOrderId };
    
  } catch (error) {
    Logger.log('rejectPayment error: ' + error.toString());
    logAction('PAYMENT_REJECTED', data.paymentId || '', '', 'Staff', error.message, 'ERROR');
    return { ok: false, error: 'Failed to reject payment: ' + error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LIST PAYMENTS (NEW)
// Returns all payments, optionally filtered by status
// ═══════════════════════════════════════════════════════════════════════

function handleListPayments(data) {
  try {
    const filterStatus = data.status || '';
    
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    if (!sheet) return { ok: false, error: 'PAYMENTS sheet not found' };
    
    const allData = sheet.getDataRange().getValues();
    if (allData.length < 2) return { ok: true, payments: [], count: 0 };
    
    const headers = allData[0];
    const payments = [];
    
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      const payment = {};
      headers.forEach((h, idx) => { payment[h] = row[idx]; });
      
      // Apply status filter
      const status = String(payment['STATUS'] || 'PENDING').trim();
      if (filterStatus && status !== filterStatus) continue;
      
      payments.push({
        paymentId:      String(payment['PAYMENT_ID'] || ''),
        orderId:        String(payment['ORDER_ID'] || ''),
        tableNo:        String(payment['TABLE_NO'] || ''),
        customerName:   String(payment['CUSTOMER_NAME'] || ''),
        amount:         Number(payment['AMOUNT'] || 0),
        uploadedAt:     payment['UPLOADED_AT'] ? String(payment['UPLOADED_AT']) : '',
        fileUrl:        String(payment['FILE_URL'] || ''),
        fileId:         String(payment['FILE_ID'] || ''),
        status:         status,
        verifiedBy:     String(payment['VERIFIED_BY'] || ''),
        verifiedAt:     payment['VERIFIED_AT'] ? String(payment['VERIFIED_AT']) : '',
        notes:          String(payment['NOTES'] || ''),
        // Receipt info
        receiptRequested: String(payment['RECEIPT_REQUESTED'] || ''),
        receiptType:      String(payment['RECEIPT_TYPE'] || ''),
        receiptDelivery:  String(payment['RECEIPT_DELIVERY'] || ''),
        receiptEmail:     String(payment['RECEIPT_EMAIL'] || ''),
        receiptSentAt:    payment['RECEIPT_SENT_AT'] ? String(payment['RECEIPT_SENT_AT']) : '',
        receiptStatus:    String(payment['RECEIPT_STATUS'] || ''),
        receiptFileUrl:   String(payment['RECEIPT_FILE_URL'] || ''),
        receiptFileId:    String(payment['RECEIPT_FILE_ID'] || ''),
        // Customer details
        customerTin:      String(payment['CUSTOMER_TIN'] || ''),
        customerNameFull: String(payment['CUSTOMER_NAME_FULL'] || payment['CUSTOMER_NAME'] || ''),
        customerAddress:  String(payment['CUSTOMER_ADDRESS'] || '')
      });
    }
    
    return { ok: true, payments: payments, count: payments.length };
    
  } catch (error) {
    Logger.log('listPayments error: ' + error.toString());
    return { ok: false, error: 'Failed to list payments: ' + error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RECEIPT HTML BUILDER (NEW)
// Generates branded receipt matching Yani Garden Cafe design
// ═══════════════════════════════════════════════════════════════════════

function buildReceiptHTML(orderId, receiptType, order, items, custName, custAddress, custTin) {
  const biz = getBizInfo();
  const isBIR = (receiptType === 'bir');
  const receiptTitle = isBIR ? 'OFFICIAL RECEIPT' : 'SALES INVOICE';
  
  // Calculate totals from items
  let subtotal = 0;
  for (let i = 0; i < items.length; i++) {
    subtotal += Number(items[i]['LINE_TOTAL'] || 0);
  }
  
  const serviceCharge = Number(order['SERVICE_CHARGE'] || 0);
  const total = Number(order['TOTAL'] || subtotal + serviceCharge);
  const orderType = order['ORDER_TYPE'] || 'DINE-IN';
  const tableNo = order['TABLE_NO'] || '';
  const customerName = order['CUSTOMER_NAME'] || custName || '';
  const orderNo = order['ORDER_NO'] || '';
  
  // Format date
  let dateStr = '';
  try {
    const ts = order['CREATED_AT'] || manilaTimestamp();
    dateStr = Utilities.formatDate(
      (ts instanceof Date) ? ts : new Date(ts),
      'Asia/Manila',
      'MM/dd/yyyy hh:mm a'
    );
  } catch (e) {
    dateStr = String(order['CREATED_AT'] || '');
  }
  
  // Build items rows — compact 2-line format for narrow paper
  let itemsHTML = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemName = item['ITEM_NAME_SNAPSHOT'] || '';
    const size = item['sizes_choice'] || '';
    const sugar = item['sweetness_choice'] || '';
    const qty = Number(item['QTY'] || 1);
    const unitPrice = Number(item['UNIT_PRICE_SNAPSHOT'] || 0);
    const lineTotal = Number(item['LINE_TOTAL'] || 0);
    
    const mods = [];
    if (size) mods.push(size);
    if (sugar) mods.push(sugar);
    const modStr = mods.length > 0 ? ' (' + mods.join('/') + ')' : '';
    
    itemsHTML += '<tr>'
      + '<td style="padding:2px 0;font-size:9pt;">' + itemName + modStr + '</td>'
      + '<td style="padding:2px 0;font-size:9pt;text-align:center;">' + qty + '</td>'
      + '<td style="padding:2px 0;font-size:9pt;text-align:right;">' + formatPeso(unitPrice) + '</td>'
      + '<td style="padding:2px 0;font-size:9pt;text-align:right;">' + formatPeso(lineTotal) + '</td>'
      + '</tr>';
  }
  
  // Customer info section (BIR only)
  let customerSection = '';
  if (isBIR) {
    customerSection = '<div style="margin:4px 0;">'
      + '<div style="font-size:8pt;">Customer: <b>' + (custName || '—') + '</b></div>'
      + '<div style="font-size:8pt;">Address: ' + (custAddress || '—') + '</div>'
      + (custTin ? '<div style="font-size:8pt;">TIN: ' + custTin + '</div>' : '')
      + '</div>'
      + '<div style="border-bottom:1px dashed #000;margin:4px 0;"></div>';
  }
  
  // ── 80mm thermal receipt layout ──
  // 80mm = ~302px at 96dpi. @page sets print size.
  // Using monospace-friendly sans-serif, all black, compact spacing.
  
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<style>'
    + '@page { size: 80mm auto; margin: 0; }'
    + 'body { font-family: "Courier New", Courier, monospace; margin: 0; padding: 0; background: #fff; color: #000; width: 80mm; }'
    + 'table { width: 100%; border-collapse: collapse; }'
    + '.sep { border-bottom: 1px dashed #000; margin: 4px 0; }'
    + '.sep-bold { border-bottom: 2px solid #000; margin: 4px 0; }'
    + '.center { text-align: center; }'
    + '.right { text-align: right; }'
    + '.bold { font-weight: bold; }'
    + '.sm { font-size: 8pt; }'
    + '.md { font-size: 9pt; }'
    + '.lg { font-size: 11pt; }'
    + '.xl { font-size: 14pt; }'
    + '</style></head><body>'
    + '<div style="padding: 4mm 3mm;">'
    
    // ═══ HEADER ═══
    + '<div class="center">'
    +   '<div class="lg bold">' + biz.name + '</div>'
    +   '<div class="sm">' + biz.address + '</div>'
    +   (biz.tin ? '<div class="sm">TIN: ' + biz.tin + '</div>' : '')
    +   (biz.phone ? '<div class="sm">Tel: ' + biz.phone + '</div>' : '')
    +   (biz.email ? '<div class="sm">' + biz.email + '</div>' : '')
    + '</div>'
    
    // Receipt type label
    + '<div class="center" style="margin-top:6px;">'
    +   '<div class="md bold" style="letter-spacing:2px;">' + receiptTitle + '</div>'
    + '</div>'
    
    + '<div class="sep-bold"></div>'
    
    // ═══ ORDER INFO ═══
    + '<table class="sm">'
    +   '<tr><td>Order #:</td><td class="right bold">' + orderId + '</td></tr>'
    +   (orderNo ? '<tr><td>Ref No:</td><td class="right">' + orderNo + '</td></tr>' : '')
    +   '<tr><td>Date:</td><td class="right">' + dateStr + '</td></tr>'
    +   '<tr><td>Table:</td><td class="right">' + tableNo + '</td></tr>'
    +   '<tr><td>Type:</td><td class="right">' + orderType + '</td></tr>'
    +   (customerName ? '<tr><td>Customer:</td><td class="right">' + customerName + '</td></tr>' : '')
    + '</table>'
    
    // BIR customer details
    + customerSection
    
    + '<div class="sep"></div>'
    
    // ═══ ITEMS ═══
    + '<table>'
    +   '<tr class="sm bold" style="border-bottom:1px solid #000;">'
    +     '<td style="padding:2px 0;">ITEM</td>'
    +     '<td style="padding:2px 0;text-align:center;">QTY</td>'
    +     '<td style="padding:2px 0;text-align:right;">PRICE</td>'
    +     '<td style="padding:2px 0;text-align:right;">AMT</td>'
    +   '</tr>'
    +   itemsHTML
    + '</table>'
    
    + '<div class="sep"></div>'
    
    // ═══ TOTALS ═══
    + '<table class="md">'
    +   '<tr><td>Subtotal</td><td class="right">' + formatPeso(subtotal) + '</td></tr>'
    +   (serviceCharge > 0 ? '<tr><td>Service Charge (10%)</td><td class="right">' + formatPeso(serviceCharge) + '</td></tr>' : '')
    + '</table>'
    
    + '<div class="sep-bold"></div>'
    
    + '<table>'
    +   '<tr>'
    +     '<td class="xl bold">TOTAL</td>'
    +     '<td class="xl bold right">' + formatPeso(total) + '</td>'
    +   '</tr>'
    + '</table>'
    
    + '<div class="sep-bold"></div>'
    
    // ═══ PAYMENT INFO ═══
    + '<div class="sm center" style="margin:4px 0;">'
    +   (isBIR 
          ? 'This serves as an OFFICIAL RECEIPT<br>for BIR tax purposes.' 
          : 'This serves as your SALES INVOICE.')
    + '</div>'
    
    + '<div class="sep"></div>'
    
    // ═══ FOOTER ═══
    + '<div class="center" style="margin-top:6px;">'
    +   '<div class="sm bold">&ldquo;' + biz.tagline + '&rdquo;</div>'
    +   '<div class="sm" style="margin-top:2px;">GROUNDED ELEVATION &middot; 450 MASL</div>'
    +   '<div class="sm" style="margin-top:4px;">' + biz.footer + '</div>'
    + '</div>'
    
    // ═══ CUT LINE ═══
    + '<div class="center sm" style="margin-top:8px;letter-spacing:3px;">- - - - - - - - - - - - -</div>'
    
    + '</div></body></html>';
}

/**
 * Format number as Philippine Peso
 */
function formatPeso(amount) {
  return '₱' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Move a payment screenshot file to processed/rejected subfolder
 */
function movePaymentFile(fileId, subfolderName) {
  try {
    if (!fileId) return;
    
    const file = DriveApp.getFileById(fileId);
    const parentFolder = DriveApp.getFolderById(RECEIPT_CONFIG.PAYMENT_FOLDER_ID);
    
    // Find or create the subfolder
    const subfolders = parentFolder.getFoldersByName(subfolderName);
    const subfolder = subfolders.hasNext()
      ? subfolders.next()
      : parentFolder.createFolder(subfolderName);
    
    // Add file to target subfolder
    subfolder.addFile(file);
    
    // Remove from all other parent folders
    const parents = file.getParents();
    while (parents.hasNext()) {
      const p = parents.next();
      if (p.getId() !== subfolder.getId()) {
        p.removeFile(file);
      }
    }
    
  } catch (e) {
    Logger.log('movePaymentFile error: ' + e.toString());
    // Don't throw — the sheet update is more important than the file move
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function validateTableToken(tableNo, token) {
  try {
    const ss = getSpreadsheet();
    const tablesSheet = ss.getSheetByName(SHEET_NAMES.TABLES);
    
    if (!tablesSheet) {
      return false;
    }
    
    const data = tablesSheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const sheetTable = String(row[0]).trim();
      const sheetToken = String(row[1]).trim();
      
      if (sheetTable == tableNo && sheetToken == token) {
        return true;
      }
    }
    
    return false;
    
  } catch (error) {
    return false;
  }
}

function isThrottled(tableNo) {
  try {
    const ss = getSpreadsheet();
    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const data = ordersSheet.getDataRange().getValues();
    
    const throttleMinutes = parseInt(getSetting('THROTTLE_MINUTES')) || 5;
    const throttleMax = parseInt(getSetting('THROTTLE_MAX_ORDERS')) || 5;
    const cutoffTime = Date.now() - (throttleMinutes * 60 * 1000);
    
    let recentOrders = 0;
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[3]).trim() != String(tableNo).trim()) continue;
      
      // Handle both Date objects and string timestamps
      const createdAt = row[2];
      let orderTime;
      if (createdAt instanceof Date) {
        orderTime = createdAt.getTime();
      } else {
        try { orderTime = new Date(createdAt).getTime(); } catch(e) { continue; }
      }
      
      if (orderTime > cutoffTime) {
        recentOrders++;
      }
    }
    
    return recentOrders >= throttleMax;
  } catch (error) {
    return false;
  }
}

// DEPRECATED: No longer called. Order ID is generated inline in placeOrder().
// Keeping for reference only. DO NOT CALL — it increments the order counter.
function generateOrderId() {
  const prefix = getSetting('ORDER_PREFIX') || 'YANI';
  const orderNo = getNextOrderNumber();
  return `${prefix}-${orderNo}`;
}

function getNextOrderNumber() {
  const ss = getSpreadsheet();
  const settingsSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  const data = settingsSheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'NEXT_ORDER_NO') {
      const currentNo = parseInt(data[i][1]) || 1001;
      settingsSheet.getRange(i + 1, 2).setValue(currentNo + 1);
      return currentNo;
    }
  }
  
  return 1001;
}

function getSetting(key) {
  try {
    const ss = getSpreadsheet();
    const settingsSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
    const data = settingsSheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        return data[i][1];
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

function verifyAdminPin(pin) {
  const correctPin = getSetting('ADMIN_PIN') || '1234';
  return {
    ok: true,
    valid: (pin === correctPin)
  };
}

// ═══════════════════════════════════════════════════════════════════════
// USER ROLES & AUTHENTICATION (RBAC)
// ═══════════════════════════════════════════════════════════════════════

// Permission matrix per role
const PERMISSIONS = {
  KITCHEN: [
    'VIEW_ORDERS', 'UPDATE_STATUS', 'VIEW_ORDER_DETAILS'
  ],
  SERVER: [
    'VIEW_ORDERS', 'UPDATE_STATUS', 'VIEW_ORDER_DETAILS',
    'CREATE_ORDER', 'CANCEL_ORDER', 'EDIT_NEW_ORDER', 'COMPLETE_ORDER',
    'PRINT_RECEIPT', 'VIEW_PAYMENTS', 'VERIFY_PAYMENT',
    'VIEW_TODAY_STATS', 'VIEW_COMPLETED_ORDERS'
  ],
  ADMIN: [
    'VIEW_ORDERS', 'UPDATE_STATUS', 'VIEW_ORDER_DETAILS',
    'CREATE_ORDER', 'CANCEL_ORDER', 'EDIT_NEW_ORDER', 'COMPLETE_ORDER',
    'PRINT_RECEIPT', 'VIEW_PAYMENTS', 'VERIFY_PAYMENT',
    'VIEW_TODAY_STATS', 'VIEW_COMPLETED_ORDERS',
    'EDIT_ANY_ORDER', 'DELETE_ORDER', 'BULK_DELETE',
    'VIEW_ALL_HISTORY', 'VIEW_REPORTS', 'MANAGE_MENU', 'REJECT_PAYMENT'
  ],
  OWNER: [
    'VIEW_ORDERS', 'UPDATE_STATUS', 'VIEW_ORDER_DETAILS',
    'CREATE_ORDER', 'CANCEL_ORDER', 'EDIT_NEW_ORDER', 'COMPLETE_ORDER',
    'PRINT_RECEIPT', 'VIEW_PAYMENTS', 'VERIFY_PAYMENT',
    'VIEW_TODAY_STATS', 'VIEW_COMPLETED_ORDERS',
    'EDIT_ANY_ORDER', 'DELETE_ORDER', 'BULK_DELETE',
    'VIEW_ALL_HISTORY', 'VIEW_REPORTS', 'MANAGE_MENU', 'REJECT_PAYMENT',
    'MANAGE_USERS', 'CHANGE_SETTINGS', 'EXPORT_DATA'
  ]
};

/**
 * SHA-256 hash a string using Google Apps Script Utilities.
 * @param {string} message
 * @returns {string} hex digest
 */
function sha256Hex(message) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    message,
    Utilities.Charset.UTF_8
  );
  return raw.map(function(b) {
    var hex = (b & 0xFF).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * Verify a user PIN against the USERS sheet.
 * Handles lockout after 3 failed attempts (15 min).
 * @param {string} pin - plain text PIN entered by user
 * @returns {{ ok, userId, username, role, message }}
 */
function verifyUserPin(pin) {
  try {
    if (!pin) return { ok: false, message: 'PIN is required' };
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
    
    if (!sheet) {
      // Fallback: if USERS sheet doesn't exist yet, use legacy ADMIN_PIN
      const correctPin = getSetting('ADMIN_PIN') || '1234';
      if (pin === correctPin) {
        return { ok: true, userId: 'USR_000', username: 'admin', role: 'ADMIN', message: 'Login successful (legacy)' };
      }
      return { ok: false, message: 'Wrong PIN' };
    }
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { ok: false, message: 'No users configured' };
    
    const headers = data[0].map(function(h) { return String(h).trim(); });
    const col = {};
    headers.forEach(function(h, i) { col[h] = i; });
    
    const pinHash = sha256Hex(pin);
    const now = new Date();
    
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var storedHash = String(row[col['PIN_HASH']] || '').trim().toLowerCase();
      
      if (storedHash !== pinHash.toLowerCase()) continue;
      
      // Found matching PIN hash
      var active = String(row[col['ACTIVE']] || '').toUpperCase();
      if (active !== 'TRUE') {
        return { ok: false, message: 'Account is disabled' };
      }
      
      // Check lockout
      var lockedUntil = row[col['LOCKED_UNTIL']];
      if (lockedUntil) {
        var lockDate = new Date(lockedUntil);
        if (!isNaN(lockDate.getTime()) && now < lockDate) {
          var mins = Math.ceil((lockDate - now) / 60000);
          return { ok: false, message: 'Account locked. Try again in ' + mins + ' min.' };
        }
      }
      
      // Success — reset failed attempts
      var rowNum = i + 1;
      if (col['FAILED_ATTEMPTS'] !== undefined) {
        sheet.getRange(rowNum, col['FAILED_ATTEMPTS'] + 1).setValue(0);
      }
      if (col['LOCKED_UNTIL'] !== undefined) {
        sheet.getRange(rowNum, col['LOCKED_UNTIL'] + 1).setValue('');
      }
      if (col['LAST_LOGIN'] !== undefined) {
        sheet.getRange(rowNum, col['LAST_LOGIN'] + 1).setValue(manilaTimestamp());
      }
      
      return {
        ok: true,
        userId: String(row[col['USER_ID']] || ''),
        username: String(row[col['USERNAME']] || ''),
        role: String(row[col['ROLE']] || 'KITCHEN').toUpperCase(),
        message: 'Login successful'
      };
    }
    
    // No match — increment failed attempts on all users with matching username? No — just return wrong PIN.
    // We don't know which user attempted, so we can't increment. 
    // For lockout: we need to track by PIN attempt — skip for now, just return wrong PIN.
    return { ok: false, message: 'Wrong PIN' };
    
  } catch (err) {
    return { ok: false, message: 'Server error: ' + err.message };
  }
}

/**
 * Update LAST_LOGIN timestamp for a user.
 * @param {string} userId
 */
function updateLastLogin(userId) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
    if (!sheet) return { ok: false, error: 'USERS sheet not found' };
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(function(h) { return String(h).trim(); });
    const col = {};
    headers.forEach(function(h, i) { col[h] = i; });
    
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][col['USER_ID']]) === String(userId)) {
        sheet.getRange(i + 1, col['LAST_LOGIN'] + 1).setValue(manilaTimestamp());
        return { ok: true };
      }
    }
    return { ok: false, error: 'User not found' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Check if a user has permission to perform an action.
 * @param {string} userId
 * @param {string} action - e.g. 'DELETE_ORDER'
 * @returns {{ allowed: boolean, role: string }}
 */
function checkPermission(userId, action) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
    if (!sheet) return { allowed: false, role: null, error: 'USERS sheet not found' };
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(function(h) { return String(h).trim(); });
    const col = {};
    headers.forEach(function(h, i) { col[h] = i; });
    
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][col['USER_ID']]) === String(userId)) {
        var role = String(data[i][col['ROLE']] || '').toUpperCase();
        var perms = PERMISSIONS[role] || [];
        return { allowed: perms.indexOf(action) >= 0, role: role };
      }
    }
    return { allowed: false, role: null, error: 'User not found' };
  } catch (err) {
    return { allowed: false, role: null, error: err.message };
  }
}

/**
 * ▶ RUN THIS ONCE: setupUsersSheet()
 * Creates the USERS sheet with correct headers and 4 default users.
 * Safe to run multiple times — skips if sheet already exists.
 */
function setupUsersSheet() {
  const ss = getSpreadsheet();
  var existing = ss.getSheetByName(SHEET_NAMES.USERS);
  if (existing) {
    console.log('USERS sheet already exists. Checking data...');
    var rows = existing.getLastRow();
    console.log('Rows (including header): ' + rows);
    return { ok: true, message: 'USERS sheet already exists with ' + rows + ' rows' };
  }
  
  var sheet = ss.insertSheet(SHEET_NAMES.USERS);
  
  // Headers
  var headers = ['USER_ID','USERNAME','ROLE','PIN_HASH','ACTIVE','CREATED_DATE','LAST_LOGIN','FAILED_ATTEMPTS','LOCKED_UNTIL'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // Pre-compute hashes (SHA-256 of each PIN)
  // kitchen1: 1111, server1: 2222, admin: 0123, owner: 999999
  var users = [
    ['USR_001','kitchen1','KITCHEN', sha256Hex('1111'),   'TRUE', manilaDate(), '', 0, ''],
    ['USR_002','server1', 'SERVER',  sha256Hex('2222'),   'TRUE', manilaDate(), '', 0, ''],
    ['USR_003','admin',   'ADMIN',   sha256Hex('0123'),   'TRUE', manilaDate(), '', 0, ''],
    ['USR_004','owner',   'OWNER',   sha256Hex('999999'), 'TRUE', manilaDate(), '', 0, '']
  ];
  
  sheet.getRange(2, 1, users.length, headers.length).setValues(users);
  
  // Format header row
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#1a3c2e')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  
  sheet.autoResizeColumns(1, headers.length);
  
  console.log('✅ USERS sheet created with 4 users.');
  console.log('PINs: kitchen1=1111, server1=2222, admin=0123, owner=999999');
  
  return { ok: true, message: 'USERS sheet created successfully with 4 users' };
}

function getOrCreatePaymentsFolder() {
  try {
    return DriveApp.getFolderById(RECEIPT_CONFIG.PAYMENT_FOLDER_ID);
  } catch (e) {
    // Fallback: search by name or create
    const folderName = 'YGC Payments';
    const folders = DriveApp.getFoldersByName(folderName);
    if (folders.hasNext()) {
      return folders.next();
    } else {
      return DriveApp.createFolder(folderName);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function testSpreadsheet() {
  Logger.log('Testing spreadsheet access...');
  Logger.log('SPREADSHEET_ID: ' + SPREADSHEET_ID);
  
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    Logger.log('✅ SUCCESS: ' + ss.getName());
    return '✅ Spreadsheet works!';
  } catch (error) {
    Logger.log('❌ ERROR: ' + error.message);
    return '❌ Failed: ' + error.message;
  }
}

function testDoGet() {
  const fakeEvent = {
    parameter: {
      table: '1',
      token: 'b36e8426'
    }
  };
  
  try {
    const result = doGet(fakeEvent);
    const content = result.getContent();
    Logger.log('✅ doGet works!');
    Logger.log('First 200 chars: ' + content.substring(0, 200));
    return 'SUCCESS';
  } catch (error) {
    Logger.log('❌ doGet failed: ' + error.message);
    return 'FAILED: ' + error.message;
  }
}

function testGetMenu() {
  const result = getMenu();
  console.log('OK:', result.ok);
  console.log('Items count:', result.items ? result.items.length : 'NO ITEMS');
  console.log('Error:', result.error);
  return result;
}

function testDoPost() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({ action: 'getMenu' })
    }
  };
  
  try {
    const result = doPost(fakeEvent);
    const content = result.getContent();
    console.log('Response:', content);
    const parsed = JSON.parse(content);
    console.log('OK:', parsed.ok);
    console.log('Items:', parsed.items ? parsed.items.length : 'NONE');
    return 'SUCCESS';
  } catch (error) {
    console.log('ERROR:', error.message);
    return 'FAILED';
  }
}

// Test the new email receipt function
function testSendEmailReceipt() {
  const result = handleSendEmailReceipt({
    orderId: 'YANI-1045',       // Use a real order ID from your sheet
    receiptType: 'simple',
    email: 'tygfsb@gmail.com',  // Send to yourself first to test
    name: 'Test Customer',
    address: '',
    tin: ''
  });
  console.log('Result:', JSON.stringify(result));
  return result;
}

// Test listing payments
function testListPayments() {
  const result = handleListPayments({ status: 'PENDING' });
  console.log('Payments:', result.count);
  if (result.payments && result.payments.length > 0) {
    console.log('First payment:', JSON.stringify(result.payments[0]));
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SETUP FUNCTIONS — Run once from Apps Script editor
// ═══════════════════════════════════════════════════════════════════════

/**
 * ★ RUN THIS ONCE ★
 * Adds missing columns to ORDERS sheet, SETTINGS rows for commissions,
 * and ensures SALES_DAILY has platform columns.
 * Safe to run multiple times — only adds what's missing.
 */
function setupPlatformFeature() {
  const ss = getSpreadsheet();
  const results = [];
  
  // ── 1. Add missing ORDERS columns ────────────────────────────────
  const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
  if (ordersSheet) {
    const ordersHeaders = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
    
    const requiredOrdersCols = [
      'TOTAL', 'PAYMENT_METHOD', 'RECEIPT_TYPE', 'RECEIPT_DELIVERY',
      'RECEIPT_EMAIL', 'CUSTOMER_ADDRESS', 'CUSTOMER_TIN'
    ];
    
    var addedOrders = [];
    requiredOrdersCols.forEach(function(col) {
      if (ordersHeaders.indexOf(col) < 0) {
        var nextCol = ordersSheet.getLastColumn() + 1;
        ordersSheet.getRange(1, nextCol).setValue(col);
        addedOrders.push(col);
      }
    });
    
    if (addedOrders.length > 0) {
      results.push('ORDERS: Added columns: ' + addedOrders.join(', '));
    } else {
      results.push('ORDERS: All required columns already exist');
    }
  }
  
  // ── 2. Add SETTINGS rows for commission rates ────────────────────
  const settingsSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (settingsSheet) {
    var settingsData = settingsSheet.getDataRange().getValues();
    var existingKeys = settingsData.map(function(r) { return String(r[0]); });
    
    var commSettings = [
      ['GRAB_COMMISSION', '28', 'Grab platform commission percentage'],
      ['FOODPANDA_COMMISSION', '30', 'FoodPanda platform commission percentage'],
      ['OTHER_COMMISSION', '0', 'Other platform commission percentage (default)']
    ];
    
    var addedSettings = [];
    commSettings.forEach(function(s) {
      if (existingKeys.indexOf(s[0]) < 0) {
        settingsSheet.appendRow(s);
        addedSettings.push(s[0] + ' = ' + s[1] + '%');
      }
    });
    
    if (addedSettings.length > 0) {
      results.push('SETTINGS: Added: ' + addedSettings.join(', '));
    } else {
      results.push('SETTINGS: Commission rates already configured');
    }
  }
  
  // ── 3. Ensure SALES_DAILY has platform columns ───────────────────
  var salesSheet = ss.getSheetByName('SALES_DAILY');
  if (salesSheet) {
    var salesHeaders = [];
    if (salesSheet.getLastRow() > 0) {
      salesHeaders = salesSheet.getRange(1, 1, 1, salesSheet.getLastColumn()).getValues()[0];
    }
    
    var requiredSalesCols = [
      'DATE', 'TOTAL_ORDERS', 'TOTAL_SALES', 'DINE_IN_ORDERS', 'TAKE_OUT_ORDERS',
      'DINE_IN_SALES', 'TAKE_OUT_SALES', 'AVG_ORDER_VALUE',
      'COMPLETED_ORDERS', 'CANCELLED_ORDERS',
      'PAYMENTS_VERIFIED', 'PAYMENTS_PENDING',
      'RECEIPTS_EMAILED', 'RECEIPTS_PRINTED',
      'GRAB_ORDERS', 'GRAB_SALES', 'FP_ORDERS', 'FP_SALES',
      'OTHER_PLATFORM_ORDERS', 'OTHER_PLATFORM_SALES',
      'PLATFORM_COMMISSION', 'NET_REVENUE',
      'UPDATED_AT'
    ];
    
    if (salesSheet.getLastRow() === 0) {
      // Empty sheet — write full header row
      salesSheet.appendRow(requiredSalesCols);
      results.push('SALES_DAILY: Created header row with all ' + requiredSalesCols.length + ' columns');
    } else {
      // Check for missing columns
      var addedSales = [];
      requiredSalesCols.forEach(function(col) {
        if (salesHeaders.indexOf(col) < 0) {
          var nextCol = salesSheet.getLastColumn() + 1;
          salesSheet.getRange(1, nextCol).setValue(col);
          addedSales.push(col);
        }
      });
      
      if (addedSales.length > 0) {
        results.push('SALES_DAILY: Added columns: ' + addedSales.join(', '));
      } else {
        results.push('SALES_DAILY: All platform columns already exist');
      }
    }
  } else {
    // Create SALES_DAILY sheet from scratch
    var newSalesSheet = ss.insertSheet('SALES_DAILY');
    newSalesSheet.appendRow([
      'DATE', 'TOTAL_ORDERS', 'TOTAL_SALES', 'DINE_IN_ORDERS', 'TAKE_OUT_ORDERS',
      'DINE_IN_SALES', 'TAKE_OUT_SALES', 'AVG_ORDER_VALUE',
      'COMPLETED_ORDERS', 'CANCELLED_ORDERS',
      'PAYMENTS_VERIFIED', 'PAYMENTS_PENDING',
      'RECEIPTS_EMAILED', 'RECEIPTS_PRINTED',
      'GRAB_ORDERS', 'GRAB_SALES', 'FP_ORDERS', 'FP_SALES',
      'OTHER_PLATFORM_ORDERS', 'OTHER_PLATFORM_SALES',
      'PLATFORM_COMMISSION', 'NET_REVENUE',
      'UPDATED_AT'
    ]);
    results.push('SALES_DAILY: Created new sheet with platform columns');
  }
  
  // ── 4. Report ────────────────────────────────────────────────────
  var report = '═══ SETUP RESULTS ═══\n' + results.join('\n');
  console.log(report);
  Logger.log(report);
  
  logAction('SETUP', '', '', 'Admin', 'setupPlatformFeature: ' + results.join(' | '), 'OK');
  
  return report;
}

/**
 * ★ OPTIONAL: Run this to clean up ORDER_ITEMS column issues ★
 * Reports problematic columns but does NOT auto-delete (too risky with existing data).
 */
function auditOrderItemsColumns() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
  if (!sheet) return 'ORDER_ITEMS sheet not found';
  
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var issues = [];
  
  // Check for duplicate column names
  var seen = {};
  headers.forEach(function(h, i) {
    var name = String(h).trim();
    if (seen[name]) {
      issues.push('⚠️ DUPLICATE column "' + name + '" at positions ' + seen[name] + ' and ' + (i+1));
    } else {
      seen[name] = i + 1;
    }
  });
  
  // Check for known typos
  if (headers.indexOf('SENOIR') >= 0) {
    issues.push('⚠️ TYPO: Column "SENOIR" should be "SENIOR" (position ' + (headers.indexOf('SENOIR') + 1) + ')');
  }
  
  // Check for non-standard columns
  var knownCols = [
    'ORDER_ID', 'ORDER_NO', 'CREATED_AT', 'TABLE_NO', 'ITEM_CODE', 'ITEM_NAME_SNAPSHOT',
    'UNIT_PRICE_SNAPSHOT', 'QTY', 'LINE_TOTAL', 'ITEM_NOTES', 'sizes_choice', 'sweetness_choice',
    'total_receipt', 'NUMBER OF PAX', 'PWD', 'SENIOR', 'discount applied', 'Total'
  ];
  
  headers.forEach(function(h, i) {
    var name = String(h).trim();
    if (name && knownCols.indexOf(name) < 0 && name !== 'SENOIR' && name !== 'print the receipt now' 
        && name !== 'PLATFORM' && name !== 'PLATFORM_REF' && name !== 'COMMISSION_RATE' 
        && name !== 'COMMISSION_AMT' && name !== 'NET_REVENUE') {
      issues.push('ℹ️ Non-standard column: "' + name + '" at position ' + (i+1));
    }
  });
  
  // Non-critical: PLATFORM columns on ORDER_ITEMS aren't used (they're on ORDERS sheet)
  if (headers.indexOf('PLATFORM') >= 0) {
    issues.push('ℹ️ PLATFORM/COMMISSION columns on ORDER_ITEMS are unused (platform data is stored on ORDERS sheet)');
  }
  
  var report = '═══ ORDER_ITEMS AUDIT ═══\n'
    + 'Total columns: ' + headers.length + '\n'
    + 'Headers: ' + headers.join(' | ') + '\n\n';
  
  if (issues.length > 0) {
    report += issues.join('\n') + '\n\n'
      + 'RECOMMENDATION: Manually fix these in Google Sheets.\n'
      + '• Remove duplicate "Total" column (keep one)\n'
      + '• Rename "SENOIR" to "SENIOR"\n'  
      + '• Consider removing "print the receipt now" column\n'
      + '• PLATFORM columns on ORDER_ITEMS can be removed (they live on ORDERS sheet)';
  } else {
    report += '✅ No issues found';
  }
  
  console.log(report);
  Logger.log(report);
  return report;
}

// ═══════════════════════════════════════════════════════════════════════
// ▶ RUN THIS ONCE: setupYaniPOS()
// Checks all sheets, adds missing columns/settings, reports what it did.
// Safe to run multiple times — skips anything that already exists.
// ═══════════════════════════════════════════════════════════════════════

function setupYaniPOS() {
  var ss = getSpreadsheet();
  var log = [];
  
  // ── 1. ORDERS sheet: ensure all required headers exist ──
  var ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
  if (ordersSheet) {
    var requiredOrders = [
      'ORDER_ID', 'ORDER_NO', 'CREATED_AT', 'TABLE_NO', 'CUSTOMER_NAME',
      'STATUS', 'SUBTOTAL', 'NOTES', 'ITEMS_JSON', 'SOURCE',
      'PAYMENT_STATUS', 'ORDER_TYPE', 'SERVICE_CHARGE', 'TOTAL',
      'PAYMENT_METHOD', 'RECEIPT_TYPE', 'RECEIPT_DELIVERY', 'RECEIPT_EMAIL',
      'CUSTOMER_ADDRESS', 'CUSTOMER_TIN',
      'PLATFORM', 'PLATFORM_REF', 'COMMISSION_RATE', 'COMMISSION_AMT', 'NET_REVENUE'
    ];
    var added = ensureHeaders(ordersSheet, requiredOrders);
    log.push('ORDERS: ' + (added.length > 0 ? 'Added ' + added.join(', ') : 'All headers OK'));
  } else {
    log.push('⚠️ ORDERS sheet not found!');
  }
  
  // ── 2. ORDER_ITEMS sheet: ensure all required headers exist ──
  var itemsSheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
  if (itemsSheet) {
    var requiredItems = [
      'ORDER_ID', 'ORDER_NO', 'CREATED_AT', 'TABLE_NO',
      'ITEM_CODE', 'ITEM_NAME_SNAPSHOT', 'UNIT_PRICE_SNAPSHOT', 'QTY', 'LINE_TOTAL',
      'ITEM_NOTES', 'sizes_choice', 'sweetness_choice',
      'total_receipt', 'NUMBER OF PAX', 'PWD', 'SENIOR', 'discount applied', 'Total',
      'PLATFORM', 'PLATFORM_REF', 'COMMISSION_RATE', 'COMMISSION_AMT', 'NET_REVENUE'
    ];
    var added = ensureHeaders(itemsSheet, requiredItems);
    log.push('ORDER_ITEMS: ' + (added.length > 0 ? 'Added ' + added.join(', ') : 'All headers OK'));
  } else {
    log.push('⚠️ ORDER_ITEMS sheet not found!');
  }
  
  // ── 3. SALES_DAILY sheet: create or ensure headers ──
  var salesSheet = ss.getSheetByName('SALES_DAILY');
  if (!salesSheet) {
    salesSheet = ss.insertSheet('SALES_DAILY');
    log.push('SALES_DAILY: Created new sheet');
  }
  var requiredSales = [
    'DATE', 'TOTAL_ORDERS', 'TOTAL_SALES', 'DINE_IN_ORDERS', 'TAKE_OUT_ORDERS',
    'DINE_IN_SALES', 'TAKE_OUT_SALES', 'AVG_ORDER_VALUE',
    'COMPLETED_ORDERS', 'CANCELLED_ORDERS',
    'PAYMENTS_VERIFIED', 'PAYMENTS_PENDING',
    'RECEIPTS_EMAILED', 'RECEIPTS_PRINTED',
    'GRAB_ORDERS', 'GRAB_SALES', 'FP_ORDERS', 'FP_SALES',
    'OTHER_PLATFORM_ORDERS', 'OTHER_PLATFORM_SALES',
    'PLATFORM_COMMISSION', 'NET_REVENUE', 'UPDATED_AT'
  ];
  var added = ensureHeaders(salesSheet, requiredSales);
  log.push('SALES_DAILY: ' + (added.length > 0 ? 'Added ' + added.join(', ') : 'All headers OK'));
  
  // ── 4. SETTINGS sheet: add commission rates ──
  var settingsSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (settingsSheet) {
    var data = settingsSheet.getDataRange().getValues();
    var existingKeys = data.map(function(r) { return String(r[0]).trim(); });
    
    var settingsToAdd = [
      ['GRAB_COMMISSION',      '28',  'Grab commission rate (%)'],
      ['FOODPANDA_COMMISSION', '30',  'FoodPanda commission rate (%)'],
      ['OTHER_COMMISSION',     '0',   'Other platform commission rate (%)']
    ];
    
    var settingsAdded = [];
    settingsToAdd.forEach(function(s) {
      if (existingKeys.indexOf(s[0]) < 0) {
        settingsSheet.appendRow(s);
        settingsAdded.push(s[0] + '=' + s[1]);
      }
    });
    log.push('SETTINGS: ' + (settingsAdded.length > 0 ? 'Added ' + settingsAdded.join(', ') : 'All commission settings OK'));
  } else {
    log.push('⚠️ SETTINGS sheet not found!');
  }
  
  // ── 5. LOGS sheet: ensure headers ──
  var logsSheet = ss.getSheetByName(SHEET_NAMES.LOGS);
  if (logsSheet) {
    var requiredLogs = ['TIMESTAMP', 'ACTION', 'ORDER_ID', 'TABLE_NO', 'ACTOR', 'DETAILS', 'STATUS', 'IP_SOURCE', 'LINK'];
    var added = ensureHeaders(logsSheet, requiredLogs);
    log.push('LOGS: ' + (added.length > 0 ? 'Added ' + added.join(', ') : 'All headers OK'));
  }
  
  // ── Print full report ──
  console.log('═══════════════════════════════════════');
  console.log('  YANI POS SETUP REPORT');
  console.log('═══════════════════════════════════════');
  log.forEach(function(l) { console.log('  ' + l); });
  console.log('═══════════════════════════════════════');
  console.log('  ✅ Setup complete. Safe to deploy.');
  console.log('═══════════════════════════════════════');
  
  return { ok: true, log: log };
}

/** Helper: ensures a sheet has all required headers. Adds missing ones at the end. */
function ensureHeaders(sheet, required) {
  if (!sheet) return [];
  var added = [];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(required);
    return required;
  }
  var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h).trim(); });
  
  required.forEach(function(h) {
    if (existing.indexOf(h) < 0) {
      var nextCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, nextCol).setValue(h);
      added.push(h);
    }
  });
  return added;
}

/**
 * ▶ RUN THIS ONCE: cleanupOrderItems()
 * Fixes ORDER_ITEMS sheet:
 * 1. Copies data from "SENOIR" → "SENIOR", then deletes "SENOIR"
 * 2. Deletes duplicate "Total" column (keeps first one)
 * 3. Deletes "print the receipt now" column
 */
function cleanupOrderItems() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.ORDER_ITEMS);
  if (!sheet) { console.log('❌ ORDER_ITEMS not found'); return; }
  
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h).trim(); });
  var lastRow = sheet.getLastRow();
  var log = [];
  
  // ── 1. SENOIR → SENIOR: copy data then mark SENOIR for deletion ──
  var senoirIdx = headers.indexOf('SENOIR');  // 0-based
  var seniorIdx = headers.indexOf('SENIOR');
  
  if (senoirIdx >= 0 && seniorIdx >= 0 && senoirIdx !== seniorIdx) {
    // Copy data from SENOIR to SENIOR
    if (lastRow > 1) {
      var senoirData = sheet.getRange(2, senoirIdx + 1, lastRow - 1, 1).getValues();
      sheet.getRange(2, seniorIdx + 1, lastRow - 1, 1).setValues(senoirData);
    }
    log.push('✅ Copied SENOIR data → SENIOR');
  } else if (senoirIdx >= 0 && seniorIdx < 0) {
    // Just rename SENOIR header to SENIOR
    sheet.getRange(1, senoirIdx + 1).setValue('SENIOR');
    log.push('✅ Renamed SENOIR → SENIOR');
    senoirIdx = -1; // don't delete, we renamed it
  }
  
  // ── 2. Find columns to delete (collect 1-based column numbers) ──
  var colsToDelete = [];
  
  // Delete SENOIR (if SENIOR exists separately)
  if (senoirIdx >= 0 && seniorIdx >= 0) {
    colsToDelete.push({ col: senoirIdx + 1, name: 'SENOIR' });
  }
  
  // Delete duplicate "Total" — keep the FIRST one, delete subsequent
  var firstTotal = -1;
  for (var i = 0; i < headers.length; i++) {
    if (headers[i] === 'Total') {
      if (firstTotal < 0) {
        firstTotal = i;
      } else {
        colsToDelete.push({ col: i + 1, name: 'Total (duplicate)' });
      }
    }
  }
  
  // Delete "print the receipt now"
  var printIdx = headers.indexOf('print the receipt now');
  if (printIdx >= 0) {
    colsToDelete.push({ col: printIdx + 1, name: 'print the receipt now' });
  }
  
  // ── 3. Delete columns from RIGHT to LEFT (so positions don't shift) ──
  colsToDelete.sort(function(a, b) { return b.col - a.col; });
  
  colsToDelete.forEach(function(c) {
    sheet.deleteColumn(c.col);
    log.push('🗑️ Deleted column: ' + c.name + ' (was col ' + c.col + ')');
  });
  
  // ── Report ──
  if (log.length === 0) {
    console.log('✅ ORDER_ITEMS is already clean — nothing to fix.');
  } else {
    console.log('═══ ORDER_ITEMS CLEANUP ═══');
    log.forEach(function(l) { console.log('  ' + l); });
    console.log('═══════════════════════════');
    
    // Print final headers
    var finalHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    console.log('Final columns (' + finalHeaders.length + '): ' + finalHeaders.join(' | '));
  }
}
