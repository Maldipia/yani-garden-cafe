/**
 * YANI POS - PHASE 1: SECURITY
 * Authentication and Audit Logging Functions
 * 
 * ADD THESE FUNCTIONS TO YOUR Code.gs IN APPS SCRIPT
 */

// ============================================================================
// AUTHENTICATION FUNCTIONS
// ============================================================================

/**
 * Verify user PIN and return user information
 * 
 * @param {string} pinHash - SHA256 hash of the PIN
 * @return {object} User data if valid, error if not
 */
function verifyUserPin(pinHash) {
  try {
    const ss = SpreadsheetApp.openById('14wSvfCy5LUfgi4d48jcGjnFpy310XYUsCWCg5VMg0g');
    const usersSheet = ss.getSheetByName('USERS');
    
    if (!usersSheet) {
      return { ok: false, message: 'USERS sheet not found. Please set up user accounts.' };
    }
    
    const data = usersSheet.getDataRange().getValues();
    
    // Skip header row, search for matching PIN hash
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const userId = row[0];
      const username = row[1];
      const role = row[2];
      const storedHash = row[3];
      const active = row[4];
      const failedAttempts = row[7] || 0;
      const lockedUntil = row[8];
      
      if (storedHash === pinHash) {
        // Check if account is active
        if (!active) {
          return { ok: false, message: 'Account is disabled. Contact administrator.' };
        }
        
        // Check if account is locked
        if (lockedUntil) {
          const lockTime = new Date(lockedUntil);
          if (lockTime > new Date()) {
            const minutesLeft = Math.ceil((lockTime - new Date()) / 60000);
            return { ok: false, message: `Account locked. Try again in ${minutesLeft} minutes.` };
          } else {
            // Lock expired, clear it
            usersSheet.getRange(i + 1, 8).setValue(0); // Clear FAILED_ATTEMPTS
            usersSheet.getRange(i + 1, 9).setValue(''); // Clear LOCKED_UNTIL
          }
        }
        
        // Login successful
        // Update last login time
        usersSheet.getRange(i + 1, 7).setValue(new Date());
        // Clear failed attempts
        usersSheet.getRange(i + 1, 8).setValue(0);
        
        return {
          ok: true,
          userId: userId,
          username: username,
          role: role,
          message: 'Login successful'
        };
      }
    }
    
    // PIN not found - could be wrong PIN or account doesn't exist
    return { ok: false, message: 'Invalid PIN. Please try again.' };
    
  } catch (error) {
    Logger.log('verifyUserPin error: ' + error);
    return { ok: false, message: 'System error. Please try again.' };
  }
}

/**
 * Check if user has permission to perform action
 * 
 * @param {string} userId - User ID
 * @param {string} action - Action to check (e.g., 'DELETE_ORDER')
 * @return {object} Permission status
 */
function checkPermission(userId, action) {
  try {
    const ss = SpreadsheetApp.openById('14wSvfCy5LUfgi4d48jcGjnFpy310XYUsCWCg5VMg0g');
    const usersSheet = ss.getSheetByName('USERS');
    
    const data = usersSheet.getDataRange().getValues();
    
    // Find user
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === userId) {
        const role = data[i][2];
        const allowed = hasPermission(role, action);
        
        return {
          allowed: allowed,
          role: role
        };
      }
    }
    
    return { allowed: false, role: null };
    
  } catch (error) {
    Logger.log('checkPermission error: ' + error);
    return { allowed: false, role: null };
  }
}

/**
 * Permission matrix - defines what each role can do
 */
function hasPermission(role, action) {
  const permissions = {
    'KITCHEN': [
      'VIEW_ORDERS',
      'UPDATE_STATUS',
      'VIEW_ORDER_DETAILS'
    ],
    'SERVER': [
      'VIEW_ORDERS',
      'UPDATE_STATUS',
      'VIEW_ORDER_DETAILS',
      'CREATE_ORDER',
      'CANCEL_ORDER',
      'EDIT_NEW_ORDER',
      'COMPLETE_ORDER',
      'PRINT_RECEIPT',
      'VIEW_PAYMENTS',
      'VERIFY_PAYMENT',
      'VIEW_TODAY_STATS',
      'VIEW_COMPLETED_ORDERS'
    ],
    'ADMIN': [
      'VIEW_ORDERS',
      'UPDATE_STATUS',
      'VIEW_ORDER_DETAILS',
      'CREATE_ORDER',
      'CANCEL_ORDER',
      'EDIT_NEW_ORDER',
      'COMPLETE_ORDER',
      'PRINT_RECEIPT',
      'VIEW_PAYMENTS',
      'VERIFY_PAYMENT',
      'VIEW_TODAY_STATS',
      'VIEW_COMPLETED_ORDERS',
      'EDIT_ANY_ORDER',
      'DELETE_ORDER',
      'BULK_DELETE',
      'VIEW_ALL_HISTORY',
      'VIEW_REPORTS',
      'MANAGE_MENU',
      'REJECT_PAYMENT'
    ],
    'OWNER': [
      // All permissions (Owner can do everything)
      'VIEW_ORDERS',
      'UPDATE_STATUS',
      'VIEW_ORDER_DETAILS',
      'CREATE_ORDER',
      'CANCEL_ORDER',
      'EDIT_NEW_ORDER',
      'COMPLETE_ORDER',
      'PRINT_RECEIPT',
      'VIEW_PAYMENTS',
      'VERIFY_PAYMENT',
      'VIEW_TODAY_STATS',
      'VIEW_COMPLETED_ORDERS',
      'EDIT_ANY_ORDER',
      'DELETE_ORDER',
      'BULK_DELETE',
      'VIEW_ALL_HISTORY',
      'VIEW_REPORTS',
      'MANAGE_MENU',
      'REJECT_PAYMENT',
      'MANAGE_USERS',
      'CHANGE_SETTINGS',
      'EXPORT_DATA',
      'VIEW_AUDIT_LOGS'
    ]
  };
  
  const rolePermissions = permissions[role] || [];
  return rolePermissions.includes(action);
}

// ============================================================================
// AUDIT LOGGING FUNCTIONS
// ============================================================================

/**
 * Log an action to the audit trail
 * 
 * @param {string} userId - User who performed the action
 * @param {string} action - Action performed
 * @param {string} target - Target of the action (order ID, item code, etc.)
 * @param {string} details - Additional details
 * @return {object} Success status
 */
function logAudit(userId, action, target, details) {
  try {
    const ss = SpreadsheetApp.openById('14wSvfCy5LUfgi4d48jcGjnFpy310XYUsCWCg5VMg0g');
    const auditSheet = ss.getSheetByName('AUDIT_LOG');
    
    if (!auditSheet) {
      Logger.log('AUDIT_LOG sheet not found');
      return { ok: false, message: 'Audit log not configured' };
    }
    
    // Get user details
    const usersSheet = ss.getSheetByName('USERS');
    const userData = usersSheet.getDataRange().getValues();
    
    let username = '';
    let role = '';
    
    for (let i = 1; i < userData.length; i++) {
      if (userData[i][0] === userId) {
        username = userData[i][1];
        role = userData[i][2];
        break;
      }
    }
    
    // Generate log ID
    const logId = 'LOG_' + new Date().getTime();
    const timestamp = new Date();
    
    // Add log entry
    auditSheet.appendRow([
      logId,
      timestamp,
      userId,
      username,
      role,
      action,
      target || '',
      details || ''
    ]);
    
    return { ok: true };
    
  } catch (error) {
    Logger.log('logAudit error: ' + error);
    return { ok: false, message: 'Failed to log action' };
  }
}

/**
 * Get recent audit logs (for Owner to view)
 * 
 * @param {number} days - Number of days to retrieve (default: 7)
 * @param {string} userId - Filter by specific user (optional)
 * @return {object} Audit log entries
 */
function getAuditLogs(days = 7, userId = null) {
  try {
    const ss = SpreadsheetApp.openById('14wSvfCy5LUfgi4d48jcGjnFpy310XYUsCWCg5VMg0g');
    const auditSheet = ss.getSheetByName('AUDIT_LOG');
    
    if (!auditSheet) {
      return { ok: false, message: 'Audit log not found' };
    }
    
    const data = auditSheet.getDataRange().getValues();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const logs = [];
    
    // Skip header row
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const timestamp = new Date(row[1]);
      
      // Filter by date
      if (timestamp < cutoffDate) continue;
      
      // Filter by user if specified
      if (userId && row[2] !== userId) continue;
      
      logs.push({
        logId: row[0],
        timestamp: row[1],
        userId: row[2],
        username: row[3],
        role: row[4],
        action: row[5],
        target: row[6],
        details: row[7]
      });
    }
    
    // Sort by timestamp (newest first)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return {
      ok: true,
      logs: logs,
      count: logs.length
    };
    
  } catch (error) {
    Logger.log('getAuditLogs error: ' + error);
    return { ok: false, message: 'Failed to retrieve audit logs' };
  }
}

// ============================================================================
// UPDATE doGet() TO HANDLE NEW ACTIONS
// ============================================================================

/**
 * UPDATE YOUR EXISTING doGet() function to include these new actions:
 * 
 * Add these cases to your switch statement:
 */

/*
case 'verifyUserPin':
  const pinHash = e.parameter.pinHash;
  return ContentService.createTextOutput(JSON.stringify(verifyUserPin(pinHash)))
    .setMimeType(ContentService.MimeType.JSON);

case 'checkPermission':
  const userId = e.parameter.userId;
  const action = e.parameter.action;
  return ContentService.createTextOutput(JSON.stringify(checkPermission(userId, action)))
    .setMimeType(ContentService.MimeType.JSON);

case 'logAudit':
  const auditUserId = e.parameter.userId;
  const auditAction = e.parameter.action;
  const auditTarget = e.parameter.target;
  const auditDetails = e.parameter.details;
  return ContentService.createTextOutput(JSON.stringify(logAudit(auditUserId, auditAction, auditTarget, auditDetails)))
    .setMimeType(ContentService.MimeType.JSON);

case 'getAuditLogs':
  const days = parseInt(e.parameter.days) || 7;
  const filterUserId = e.parameter.userId || null;
  return ContentService.createTextOutput(JSON.stringify(getAuditLogs(days, filterUserId)))
    .setMimeType(ContentService.MimeType.JSON);
*/

// ============================================================================
// SHA256 HASH GENERATOR (FOR TESTING)
// ============================================================================

/**
 * Generate SHA256 hash of a PIN (for testing/creating new users)
 * Run this function in Apps Script editor to generate hashes
 */
function testGeneratePinHash() {
  const testPins = ['1111', '2222', '0123', '999999'];
  
  testPins.forEach(pin => {
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pin);
    const hashHex = hash.map(byte => {
      const v = (byte < 0) ? 256 + byte : byte;
      return ("0" + v.toString(16)).slice(-2);
    }).join('');
    
    Logger.log(`PIN: ${pin} → Hash: ${hashHex}`);
  });
}

// ============================================================================
// DEPLOYMENT CHECKLIST
// ============================================================================

/*
AFTER ADDING THESE FUNCTIONS TO CODE.GS:

1. ✅ Create USERS sheet in Google Sheets
2. ✅ Create AUDIT_LOG sheet in Google Sheets
3. ✅ Add 4 default users to USERS sheet
4. ✅ Update doGet() function with new action cases
5. ✅ Deploy as web app (New Deployment)
6. ✅ Test login with each PIN (1111, 2222, 0123, 999999)
7. ✅ Verify audit logs are being created
8. ✅ Test permission checks for each role

TESTING URLS:
- Verify PIN: ?action=verifyUserPin&pinHash=[HASH]
- Check Permission: ?action=checkPermission&userId=USR_001&action=DELETE_ORDER
- Get Audit Logs: ?action=getAuditLogs&days=7

*/
