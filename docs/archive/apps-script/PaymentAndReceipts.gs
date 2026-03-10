// ═══════════════════════════════════════════════════════════════
// YANI GARDEN CAFE — Payment & Receipt Functions
// ═══════════════════════════════════════════════════════════════
//
// HOW TO INSTALL:
// 1. Open Google Sheets → Extensions → Apps Script
// 2. Click "+" next to Files → Script
// 3. Name it "PaymentAndReceipts"
// 4. Paste this ENTIRE file
// 5. In your MAIN Code.gs file, add the new cases to doPost()
//    (see STEP 2 at the bottom of this file)
// 6. Click "Deploy" → "Manage deployments" → Edit → New version → Deploy
//
// SENDER EMAIL: tygfsb@gmail.com
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ──────────────────────────────────────────────────────
var RECEIPT_CONFIG = {
  SPREADSHEET_ID: '14wSvfCy5LUrlgi4d48jcGjnFpy310XYUsCWCg5VMg0g',
  
  // Receipt folders (from your Google Drive)
  SIMPLE_RECEIPT_FOLDER_ID: '1HLPCkeTqRDPTvpmCvqwd65rqkT1fAjfx',  // YGC SALES invoice
  BIR_RECEIPT_FOLDER_ID:    '1iIUE6O_alTLFfh9jLOX6eiYLom3TZF_g',  // YGC SALES (BIR)
  
  // Payment folders (from your Google Drive)
  PAYMENT_FOLDER_ID:     '1hDQlljGpRUwT9q33xHukbXvz_M8tk5lR',  // YGC payment
  // processed and rejected are subfolders — found dynamically
  
  // Sender
  SENDER_EMAIL: 'tygfsb@gmail.com',
  SENDER_NAME:  'Yani Garden Cafe',
  
  // Business info for receipts
  BUSINESS_NAME:    'YANI GARDEN CAFE',
  BUSINESS_ADDRESS: 'Amadeo, Cavite 4119',
  BUSINESS_TIN:     '',  // Add your TIN here if you have one
  BUSINESS_PHONE:   '',  // Add phone if needed
};


// ═══════════════════════════════════════════════════════════════
// 1. SEND EMAIL RECEIPT
// ═══════════════════════════════════════════════════════════════
//
// Called when customer chooses "Email Receipt" 
// Generates PDF, saves to Drive, emails to customer
//
// Params: { orderId, receiptType ('simple'|'bir'), email,
//           name?, address?, tin? }
//
function handleSendEmailReceipt(data) {
  try {
    var orderId     = data.orderId;
    var receiptType = data.receiptType || 'simple';  // 'simple' or 'bir'
    var email       = data.email;
    var custName    = data.name || '';
    var custAddress = data.address || '';
    var custTin     = data.tin || '';
    
    if (!orderId) return { ok: false, error: 'Missing orderId' };
    if (!email)   return { ok: false, error: 'Missing email address' };
    
    // ── Get order data ──
    var ss = SpreadsheetApp.openById(RECEIPT_CONFIG.SPREADSHEET_ID);
    
    // Get order from ORDERS sheet
    var ordersSheet = ss.getSheetByName('ORDERS');
    var orderData = findOrderById_(ordersSheet, orderId);
    if (!orderData) return { ok: false, error: 'Order not found: ' + orderId };
    
    // Get order items from ORDER_ITEMS sheet
    var itemsSheet = ss.getSheetByName('ORDER_ITEMS');
    var orderItems = findOrderItems_(itemsSheet, orderId);
    if (!orderItems || orderItems.length === 0) {
      return { ok: false, error: 'No items found for order: ' + orderId };
    }
    
    // ── Build receipt HTML ──
    var html = buildReceiptHTML_({
      orderId:     orderId,
      receiptType: receiptType,
      order:       orderData,
      items:       orderItems,
      custName:    custName,
      custAddress: custAddress,
      custTin:     custTin,
    });
    
    // ── Convert HTML to PDF ──
    var pdfBlob = HtmlService.createHtmlOutput(html)
      .getContent();
    
    // Use a temporary HTML file to create PDF via Drive
    var tempFile = DriveApp.createFile('temp_receipt.html', pdfBlob, 'text/html');
    var pdfFile = DriveApp.createFile(
      tempFile.getAs('application/pdf')
        .setName(orderId + '_receipt.pdf')
    );
    tempFile.setTrashed(true);  // Clean up temp file
    
    // ── Move PDF to correct folder ──
    var folderId = (receiptType === 'bir') 
      ? RECEIPT_CONFIG.BIR_RECEIPT_FOLDER_ID 
      : RECEIPT_CONFIG.SIMPLE_RECEIPT_FOLDER_ID;
    
    var folder = DriveApp.getFolderById(folderId);
    folder.addFile(pdfFile);
    DriveApp.getRootFolder().removeFile(pdfFile);  // Remove from root
    
    var pdfUrl = pdfFile.getUrl();
    
    // ── Send email ──
    var subject = (receiptType === 'bir') 
      ? 'Official Receipt - ' + orderId + ' | Yani Garden Cafe'
      : 'Sales Invoice - ' + orderId + ' | Yani Garden Cafe';
    
    var emailBody = buildEmailBody_(orderId, receiptType, orderData);
    
    GmailApp.sendEmail(email, subject, '', {
      htmlBody: emailBody,
      attachments: [pdfFile.getAs('application/pdf')],
      name: RECEIPT_CONFIG.SENDER_NAME,
      from: RECEIPT_CONFIG.SENDER_EMAIL,
    });
    
    // ── Update ORDERS sheet with receipt info ──
    updateOrderReceiptStatus_(ordersSheet, orderId, receiptType, 'email', email);
    
    return { 
      ok: true, 
      message: 'Receipt sent to ' + email,
      receiptUrl: pdfUrl
    };
    
  } catch (e) {
    Logger.log('sendEmailReceipt error: ' + e.toString());
    return { ok: false, error: 'Failed to send receipt: ' + e.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// 2. VERIFY PAYMENT
// ═══════════════════════════════════════════════════════════════
//
// Staff verifies a payment screenshot. Moves file to
// "processed" subfolder and updates PAYMENTS sheet.
//
// Params: { paymentId, verifiedBy? }
//
function handleVerifyPayment(data) {
  try {
    var paymentId  = data.paymentId;
    var verifiedBy = data.verifiedBy || 'Staff';
    
    if (!paymentId) return { ok: false, error: 'Missing paymentId' };
    
    var ss = SpreadsheetApp.openById(RECEIPT_CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName('PAYMENTS');
    if (!sheet) return { ok: false, error: 'PAYMENTS sheet not found' };
    
    // Find the payment row
    var result = findPaymentRow_(sheet, paymentId);
    if (!result) return { ok: false, error: 'Payment not found: ' + paymentId };
    
    var row = result.row;
    var fileId = result.fileId;
    
    // Update STATUS → VERIFIED
    var headers = getSheetHeaders_(sheet);
    var statusCol  = headers.indexOf('STATUS') + 1;
    var verByCol   = headers.indexOf('VERIFIED_BY') + 1;
    var verAtCol   = headers.indexOf('VERIFIED_AT') + 1;
    
    if (statusCol > 0) sheet.getRange(row, statusCol).setValue('VERIFIED');
    if (verByCol > 0)  sheet.getRange(row, verByCol).setValue(verifiedBy);
    if (verAtCol > 0)  sheet.getRange(row, verAtCol).setValue(new Date());
    
    // Move file to "processed" subfolder
    if (fileId) {
      movePaymentFile_(fileId, 'processed');
    }
    
    return { ok: true, message: 'Payment ' + paymentId + ' verified' };
    
  } catch (e) {
    Logger.log('verifyPayment error: ' + e.toString());
    return { ok: false, error: 'Failed to verify payment: ' + e.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// 3. REJECT PAYMENT
// ═══════════════════════════════════════════════════════════════
//
// Staff rejects a payment screenshot. Moves file to
// "rejected" subfolder and updates PAYMENTS sheet.
//
// Params: { paymentId, reason?, verifiedBy? }
//
function handleRejectPayment(data) {
  try {
    var paymentId  = data.paymentId;
    var reason     = data.reason || '';
    var verifiedBy = data.verifiedBy || 'Staff';
    
    if (!paymentId) return { ok: false, error: 'Missing paymentId' };
    
    var ss = SpreadsheetApp.openById(RECEIPT_CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName('PAYMENTS');
    if (!sheet) return { ok: false, error: 'PAYMENTS sheet not found' };
    
    var result = findPaymentRow_(sheet, paymentId);
    if (!result) return { ok: false, error: 'Payment not found: ' + paymentId };
    
    var row = result.row;
    var fileId = result.fileId;
    
    var headers = getSheetHeaders_(sheet);
    var statusCol = headers.indexOf('STATUS') + 1;
    var verByCol  = headers.indexOf('VERIFIED_BY') + 1;
    var verAtCol  = headers.indexOf('VERIFIED_AT') + 1;
    var notesCol  = headers.indexOf('NOTES') + 1;
    
    if (statusCol > 0) sheet.getRange(row, statusCol).setValue('REJECTED');
    if (verByCol > 0)  sheet.getRange(row, verByCol).setValue(verifiedBy);
    if (verAtCol > 0)  sheet.getRange(row, verAtCol).setValue(new Date());
    if (notesCol > 0 && reason) sheet.getRange(row, notesCol).setValue('Rejected: ' + reason);
    
    // Move file to "rejected" subfolder
    if (fileId) {
      movePaymentFile_(fileId, 'rejected');
    }
    
    return { ok: true, message: 'Payment ' + paymentId + ' rejected' };
    
  } catch (e) {
    Logger.log('rejectPayment error: ' + e.toString());
    return { ok: false, error: 'Failed to reject payment: ' + e.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// 4. LIST PAYMENTS
// ═══════════════════════════════════════════════════════════════
//
// Returns all payments, optionally filtered by status.
//
// Params: { status? ('PENDING'|'VERIFIED'|'REJECTED') }
//
function handleListPayments(data) {
  try {
    var filterStatus = data.status || '';
    
    var ss = SpreadsheetApp.openById(RECEIPT_CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName('PAYMENTS');
    if (!sheet) return { ok: false, error: 'PAYMENTS sheet not found' };
    
    var headers = getSheetHeaders_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: true, payments: [] };
    
    var dataRange = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var payments = [];
    
    for (var i = 0; i < dataRange.length; i++) {
      var row = dataRange[i];
      var payment = {};
      for (var j = 0; j < headers.length; j++) {
        payment[headers[j]] = row[j];
      }
      
      // Apply status filter
      if (filterStatus && payment['STATUS'] !== filterStatus) continue;
      
      payments.push({
        paymentId:    payment['PAYMENT_ID'] || '',
        orderId:      payment['ORDER_ID'] || '',
        tableNo:      payment['TABLE_NO'] || '',
        customerName: payment['CUSTOMER_NAME'] || '',
        amount:       payment['AMOUNT'] || 0,
        uploadedAt:   payment['UPLOADED_AT'] ? payment['UPLOADED_AT'].toString() : '',
        fileUrl:      payment['FILE_URL'] || '',
        fileId:       payment['FILE_ID'] || '',
        status:       payment['STATUS'] || 'PENDING',
        verifiedBy:   payment['VERIFIED_BY'] || '',
        verifiedAt:   payment['VERIFIED_AT'] ? payment['VERIFIED_AT'].toString() : '',
        notes:        payment['NOTES'] || '',
      });
    }
    
    return { ok: true, payments: payments, count: payments.length };
    
  } catch (e) {
    Logger.log('listPayments error: ' + e.toString());
    return { ok: false, error: 'Failed to list payments: ' + e.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (private, prefixed with _)
// ═══════════════════════════════════════════════════════════════

/**
 * Get column headers from row 1 of a sheet
 */
function getSheetHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h).trim();
  });
}

/**
 * Find an order by ORDER_ID in ORDERS sheet
 * Returns object with all order fields, or null
 */
function findOrderById_(sheet, orderId) {
  var headers = getSheetHeaders_(sheet);
  var orderIdCol = headers.indexOf('ORDER_ID');
  if (orderIdCol === -1) {
    // Try alternate column names
    orderIdCol = headers.indexOf('order_id');
    if (orderIdCol === -1) orderIdCol = headers.indexOf('Order ID');
    if (orderIdCol === -1) orderIdCol = 0;  // Assume first column
  }
  
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  
  var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][orderIdCol]).trim() === String(orderId).trim()) {
      var order = { _row: i + 2 };
      for (var j = 0; j < headers.length; j++) {
        order[headers[j]] = data[i][j];
      }
      return order;
    }
  }
  return null;
}

/**
 * Find all items for an order in ORDER_ITEMS sheet
 */
function findOrderItems_(sheet, orderId) {
  var headers = getSheetHeaders_(sheet);
  var orderIdCol = headers.indexOf('ORDER_ID');
  if (orderIdCol === -1) orderIdCol = 0;
  
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  
  var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var items = [];
  
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][orderIdCol]).trim() === String(orderId).trim()) {
      var item = {};
      for (var j = 0; j < headers.length; j++) {
        item[headers[j]] = data[i][j];
      }
      items.push(item);
    }
  }
  return items;
}

/**
 * Find a payment row by PAYMENT_ID
 * Returns { row, fileId } or null
 */
function findPaymentRow_(sheet, paymentId) {
  var headers = getSheetHeaders_(sheet);
  var pidCol = headers.indexOf('PAYMENT_ID');
  var fidCol = headers.indexOf('FILE_ID');
  if (pidCol === -1) pidCol = 0;
  
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  
  var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][pidCol]).trim() === String(paymentId).trim()) {
      return {
        row: i + 2,
        fileId: (fidCol >= 0) ? String(data[i][fidCol]).trim() : ''
      };
    }
  }
  return null;
}

/**
 * Move a payment screenshot file to a subfolder (processed/rejected)
 */
function movePaymentFile_(fileId, subfolderName) {
  try {
    if (!fileId) return;
    
    var file = DriveApp.getFileById(fileId);
    var parentFolder = DriveApp.getFolderById(RECEIPT_CONFIG.PAYMENT_FOLDER_ID);
    
    // Find the subfolder by name
    var subfolders = parentFolder.getFoldersByName(subfolderName);
    if (!subfolders.hasNext()) {
      // Create subfolder if it doesn't exist
      var subfolder = parentFolder.createFolder(subfolderName);
    } else {
      var subfolder = subfolders.next();
    }
    
    // Add file to the target subfolder
    subfolder.addFile(file);
    
    // Remove from ALL current parent folders (handles files in any location)
    var parents = file.getParents();
    while (parents.hasNext()) {
      var p = parents.next();
      // Don't remove from the subfolder we just added to
      if (p.getId() !== subfolder.getId()) {
        p.removeFile(file);
      }
    }
    
  } catch (e) {
    Logger.log('movePaymentFile_ error: ' + e.toString());
    // Don't throw — payment status update is more important than file move
  }
}

/**
 * Update the ORDERS sheet with receipt status after sending
 */
function updateOrderReceiptStatus_(sheet, orderId, receiptType, delivery, email) {
  var headers = getSheetHeaders_(sheet);
  var orderIdCol = headers.indexOf('ORDER_ID');
  if (orderIdCol === -1) orderIdCol = 0;
  
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  var data = sheet.getRange(2, orderIdCol + 1, lastRow - 1, 1).getValues();
  
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(orderId).trim()) {
      var row = i + 2;
      
      // Find receipt columns — try common names
      var rtCol = headers.indexOf('RECEIPT_TYPE');
      if (rtCol === -1) rtCol = headers.indexOf('receipt_type');
      
      var rdCol = headers.indexOf('RECEIPT_DELIVERY');
      if (rdCol === -1) rdCol = headers.indexOf('receipt_delivery');
      
      var reCol = headers.indexOf('RECEIPT_EMAIL');
      if (reCol === -1) reCol = headers.indexOf('receipt_email');
      
      if (rtCol >= 0) sheet.getRange(row, rtCol + 1).setValue(receiptType);
      if (rdCol >= 0) sheet.getRange(row, rdCol + 1).setValue(delivery);
      if (reCol >= 0) sheet.getRange(row, reCol + 1).setValue(email);
      
      break;
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// RECEIPT HTML TEMPLATE
// ═══════════════════════════════════════════════════════════════

/**
 * Build the receipt HTML for PDF generation
 */
function buildReceiptHTML_(params) {
  var orderId     = params.orderId;
  var receiptType = params.receiptType;
  var order       = params.order;
  var items       = params.items;
  var custName    = params.custName;
  var custAddress = params.custAddress;
  var custTin     = params.custTin;
  
  var isBIR = (receiptType === 'bir');
  var receiptTitle = isBIR ? 'OFFICIAL RECEIPT' : 'SALES INVOICE';
  
  // Calculate totals
  var subtotal = 0;
  for (var i = 0; i < items.length; i++) {
    subtotal += Number(items[i]['LINE_TOTAL'] || items[i]['line_total'] || 0);
  }
  
  var serviceCharge = Number(order['SERVICE_CHARGE'] || order['service_charge'] || 0);
  var total = Number(order['TOTAL'] || order['total'] || subtotal + serviceCharge);
  var orderType = order['ORDER_TYPE'] || order['order_type'] || order['TYPE'] || 'DINE-IN';
  var orderDate = order['CREATED_AT'] || order['created_at'] || order['TIMESTAMP'] || order['timestamp'] || new Date();
  
  // Format date
  var dateStr;
  if (orderDate instanceof Date) {
    dateStr = Utilities.formatDate(orderDate, 'Asia/Manila', 'MMM dd, yyyy hh:mm a');
  } else {
    try {
      dateStr = Utilities.formatDate(new Date(orderDate), 'Asia/Manila', 'MMM dd, yyyy hh:mm a');
    } catch (e) {
      dateStr = String(orderDate);
    }
  }
  
  // Build items rows
  var itemsHTML = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var itemName = item['ITEM_NAME_SNAPSHOT'] || item['item_name_snapshot'] || item['ITEM_NAME'] || '';
    var size = item['sizes_choice'] || item['SIZES_CHOICE'] || '';
    var sugar = item['sweetness_choice'] || item['SWEETNESS_CHOICE'] || '';
    var qty = Number(item['QTY'] || item['qty'] || 1);
    var unitPrice = Number(item['UNIT_PRICE_SNAPSHOT'] || item['unit_price_snapshot'] || 0);
    var lineTotal = Number(item['LINE_TOTAL'] || item['line_total'] || 0);
    
    // Build description line
    var desc = itemName;
    var details = [];
    if (size) details.push(size);
    if (sugar) details.push(sugar);
    var detailStr = details.length > 0 ? details.join(' | ') : '';
    
    itemsHTML += '<tr>' +
      '<td style="padding:6px 0;border-bottom:1px solid #e8e0d4;">' +
        '<div style="font-size:13px;color:#314C47;font-weight:500;">' + desc + '</div>' +
        (detailStr ? '<div style="font-size:11px;color:#8a7e6b;margin-top:2px;">' + detailStr + '</div>' : '') +
      '</td>' +
      '<td style="padding:6px 0;border-bottom:1px solid #e8e0d4;text-align:center;font-size:12px;color:#555;">' + qty + '</td>' +
      '<td style="padding:6px 0;border-bottom:1px solid #e8e0d4;text-align:right;font-size:12px;color:#555;">₱' + unitPrice.toFixed(2) + '</td>' +
      '<td style="padding:6px 0;border-bottom:1px solid #e8e0d4;text-align:right;font-size:13px;color:#314C47;font-weight:500;">₱' + lineTotal.toFixed(2) + '</td>' +
    '</tr>';
  }
  
  // Customer info section (BIR only)
  var customerSection = '';
  if (isBIR) {
    customerSection = '' +
      '<table style="width:100%;margin-bottom:16px;font-size:12px;">' +
        '<tr><td style="color:#8a7e6b;padding:3px 0;width:80px;">Name:</td><td style="color:#314C47;font-weight:500;">' + (custName || '—') + '</td></tr>' +
        '<tr><td style="color:#8a7e6b;padding:3px 0;">Address:</td><td style="color:#314C47;">' + (custAddress || '—') + '</td></tr>' +
        (custTin ? '<tr><td style="color:#8a7e6b;padding:3px 0;">TIN:</td><td style="color:#314C47;">' + custTin + '</td></tr>' : '') +
      '</table>' +
      '<div style="border-bottom:1px dashed #d4c9b8;margin-bottom:16px;"></div>';
  }
  
  // Full HTML receipt
  var html = '<!DOCTYPE html>' +
  '<html><head><meta charset="utf-8">' +
  '<style>' +
    '@import url("https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600;700&family=Quicksand:wght@400;500;600;700&display=swap");' +
    'body { font-family: "Quicksand", "Helvetica Neue", Arial, sans-serif; margin: 0; padding: 0; background: #fff; color: #333; }' +
    'h1, h2, h3 { font-family: "Crimson Pro", Georgia, serif; }' +
  '</style>' +
  '</head><body>' +
  
  '<div style="max-width:520px;margin:0 auto;padding:32px 28px;background:#fff;">' +
  
    // ── Header ──
    '<div style="text-align:center;margin-bottom:20px;">' +
      '<div style="font-family:\'Crimson Pro\',Georgia,serif;font-size:24px;font-weight:700;color:#314C47;letter-spacing:1px;">' +
        RECEIPT_CONFIG.BUSINESS_NAME +
      '</div>' +
      '<div style="font-size:12px;color:#8a7e6b;margin-top:4px;">' +
        RECEIPT_CONFIG.BUSINESS_ADDRESS +
      '</div>' +
      (RECEIPT_CONFIG.BUSINESS_TIN ? '<div style="font-size:11px;color:#8a7e6b;">TIN: ' + RECEIPT_CONFIG.BUSINESS_TIN + '</div>' : '') +
      '<div style="margin-top:10px;font-family:\'Crimson Pro\',Georgia,serif;font-size:16px;color:#C4704B;font-weight:600;letter-spacing:2px;">' +
        receiptTitle +
      '</div>' +
    '</div>' +
  
    '<div style="border-bottom:2px solid #314C47;margin-bottom:16px;"></div>' +
  
    // ── Order info ──
    '<table style="width:100%;margin-bottom:16px;font-size:12px;">' +
      '<tr>' +
        '<td style="color:#8a7e6b;padding:3px 0;">Order No:</td>' +
        '<td style="color:#314C47;font-weight:600;">' + orderId + '</td>' +
        '<td style="color:#8a7e6b;text-align:right;">Date:</td>' +
        '<td style="color:#314C47;text-align:right;">' + dateStr + '</td>' +
      '</tr>' +
      '<tr>' +
        '<td style="color:#8a7e6b;padding:3px 0;">Table:</td>' +
        '<td style="color:#314C47;">' + (order['TABLE_NO'] || order['table_no'] || order['TABLE'] || '—') + '</td>' +
        '<td style="color:#8a7e6b;text-align:right;">Type:</td>' +
        '<td style="color:#314C47;text-align:right;">' + orderType + '</td>' +
      '</tr>' +
    '</table>' +
  
    // ── Customer info (BIR only) ──
    customerSection +
  
    // ── Items table ──
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">' +
      '<tr style="border-bottom:2px solid #314C47;">' +
        '<th style="text-align:left;padding:8px 0;font-size:11px;color:#8a7e6b;text-transform:uppercase;letter-spacing:1px;">Item</th>' +
        '<th style="text-align:center;padding:8px 0;font-size:11px;color:#8a7e6b;text-transform:uppercase;letter-spacing:1px;">Qty</th>' +
        '<th style="text-align:right;padding:8px 0;font-size:11px;color:#8a7e6b;text-transform:uppercase;letter-spacing:1px;">Price</th>' +
        '<th style="text-align:right;padding:8px 0;font-size:11px;color:#8a7e6b;text-transform:uppercase;letter-spacing:1px;">Amount</th>' +
      '</tr>' +
      itemsHTML +
    '</table>' +
  
    // ── Totals ──
    '<div style="border-top:1px dashed #d4c9b8;padding-top:12px;">' +
      '<table style="width:100%;font-size:13px;">' +
        '<tr>' +
          '<td style="color:#8a7e6b;padding:4px 0;">Subtotal</td>' +
          '<td style="text-align:right;color:#314C47;">₱' + subtotal.toFixed(2) + '</td>' +
        '</tr>' +
        (serviceCharge > 0 ? 
        '<tr>' +
          '<td style="color:#8a7e6b;padding:4px 0;">Service Charge (10%)</td>' +
          '<td style="text-align:right;color:#314C47;">₱' + serviceCharge.toFixed(2) + '</td>' +
        '</tr>' : '') +
      '</table>' +
    '</div>' +
  
    '<div style="border-top:2px solid #314C47;margin-top:8px;padding-top:12px;">' +
      '<table style="width:100%;">' +
        '<tr>' +
          '<td style="font-family:\'Crimson Pro\',Georgia,serif;font-size:18px;font-weight:700;color:#314C47;">TOTAL</td>' +
          '<td style="text-align:right;font-family:\'Crimson Pro\',Georgia,serif;font-size:18px;font-weight:700;color:#C4704B;">₱' + total.toFixed(2) + '</td>' +
        '</tr>' +
      '</table>' +
    '</div>' +
  
    // ── Footer ──
    '<div style="text-align:center;margin-top:28px;padding-top:16px;border-top:1px dashed #d4c9b8;">' +
      '<div style="font-family:\'Crimson Pro\',Georgia,serif;font-size:14px;color:#314C47;font-style:italic;">' +
        '"A highland sanctuary for the soul"' +
      '</div>' +
      '<div style="font-size:11px;color:#B8973A;margin-top:6px;letter-spacing:1px;">' +
        '✦ GROUNDED ELEVATION · 450 MASL ✦' +
      '</div>' +
      '<div style="font-size:10px;color:#aaa;margin-top:8px;">' +
        'Thank you for visiting Yani Garden Cafe' +
      '</div>' +
      (isBIR ? '<div style="font-size:9px;color:#bbb;margin-top:4px;">This serves as an Official Receipt for BIR purposes.</div>' : '') +
    '</div>' +
  
  '</div>' +
  '</body></html>';
  
  return html;
}

/**
 * Build the email body HTML (wrapper around the receipt)
 */
function buildEmailBody_(orderId, receiptType, order) {
  var total = Number(order['TOTAL'] || order['total'] || 0);
  var isBIR = (receiptType === 'bir');
  
  return '<!DOCTYPE html>' +
  '<html><body style="font-family:Helvetica Neue,Arial,sans-serif;margin:0;padding:0;background:#f5f0ea;">' +
  '<div style="max-width:560px;margin:0 auto;padding:32px 20px;">' +
  
    // Logo area
    '<div style="text-align:center;padding:24px 0;">' +
      '<div style="font-size:28px;font-weight:700;color:#314C47;letter-spacing:1px;">YANI GARDEN CAFE</div>' +
      '<div style="font-size:12px;color:#B8973A;letter-spacing:2px;margin-top:4px;">GROUNDED ELEVATION</div>' +
    '</div>' +
  
    // Card
    '<div style="background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
      '<div style="text-align:center;margin-bottom:20px;">' +
        '<div style="font-size:36px;">☕</div>' +
        '<div style="font-size:18px;color:#314C47;font-weight:600;margin-top:8px;">' +
          (isBIR ? 'Your Official Receipt' : 'Your Sales Invoice') +
        '</div>' +
        '<div style="font-size:13px;color:#8a7e6b;margin-top:4px;">Order ' + orderId + '</div>' +
      '</div>' +
      
      '<div style="background:#f9f6f1;border-radius:8px;padding:16px;text-align:center;margin-bottom:20px;">' +
        '<div style="font-size:13px;color:#8a7e6b;">Amount</div>' +
        '<div style="font-size:24px;font-weight:700;color:#C4704B;">₱' + total.toFixed(2) + '</div>' +
      '</div>' +
      
      '<div style="font-size:13px;color:#666;line-height:1.6;">' +
        'Your receipt is attached as a PDF. Please save it for your records.' +
        (isBIR ? ' This receipt is valid for BIR tax deduction purposes.' : '') +
      '</div>' +
    '</div>' +
  
    // Footer
    '<div style="text-align:center;padding:20px;font-size:11px;color:#aaa;">' +
      'Yani Garden Cafe · Amadeo, Cavite 4119<br>' +
      'Part of The Blessing Trilogy' +
    '</div>' +
  
  '</div>' +
  '</body></html>';
}


// ═══════════════════════════════════════════════════════════════
// STEP 2: ADD THESE CASES TO YOUR doPost() FUNCTION
// ═══════════════════════════════════════════════════════════════
//
// Open your MAIN Code.gs file, find the switch(action) block,
// and add these cases BEFORE the "default:" line:
//
//     case 'sendEmailReceipt':
//       return sendJSON(handleSendEmailReceipt(data));
//
//     case 'verifyPayment':
//       return sendJSON(handleVerifyPayment(data));
//
//     case 'rejectPayment':
//       return sendJSON(handleRejectPayment(data));
//
//     case 'listPayments':
//       return sendJSON(handleListPayments(data));
//
// ═══════════════════════════════════════════════════════════════
// ALSO UPDATE YOUR EXISTING requestReceipt CASE:
// ═══════════════════════════════════════════════════════════════
//
// Find your existing "case 'requestReceipt':" and REPLACE it with:
//
//     case 'requestReceipt':
//       // If delivery is 'email', send the receipt via email
//       if (data.delivery === 'email' && data.email) {
//         return sendJSON(handleSendEmailReceipt(data));
//       }
//       // Otherwise just log it (printed receipts handled at counter)
//       return sendJSON({ ok: true, message: 'Receipt will be ready at the counter' });
//
// ═══════════════════════════════════════════════════════════════
// DONE! After pasting, click Deploy → Manage Deployments →
// Edit pencil → Version: New version → Deploy
// ═══════════════════════════════════════════════════════════════
