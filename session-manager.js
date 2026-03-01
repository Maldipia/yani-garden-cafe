/**
 * YANI POS - SESSION MANAGEMENT & PERMISSIONS
 * 
 * Include this in admin.html BEFORE your main script
 * This handles session validation and permission checks
 */

const SESSION_KEY = 'yaniSession';
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const API_URL = 'https://script.google.com/macros/s/AKfycbytCV-jiFSOoon7Ijww5a-AABRYzhiNZPXVubaaa2zoVBOFxvcgkDH-6e4CfksMA7LC/exec';

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Check if user is logged in and session is valid
 * Redirects to login page if not
 */
function checkSession() {
    const session = getSession();
    
    if (!session) {
        redirectToLogin();
        return null;
    }
    
    // Check if session expired
    const expiresAt = new Date(session.expiresAt);
    if (expiresAt < new Date()) {
        clearSession();
        alert('Your session has expired. Please log in again.');
        redirectToLogin();
        return null;
    }
    
    // Refresh session expiration (activity detected)
    refreshSession();
    
    return session;
}

/**
 * Get current session data
 */
function getSession() {
    try {
        const sessionStr = localStorage.getItem(SESSION_KEY);
        if (!sessionStr) return null;
        return JSON.parse(sessionStr);
    } catch (error) {
        console.error('Session parse error:', error);
        return null;
    }
}

/**
 * Refresh session expiration time
 */
function refreshSession() {
    const session = getSession();
    if (session) {
        session.expiresAt = new Date(Date.now() + SESSION_TIMEOUT).toISOString();
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
}

/**
 * Clear session and redirect to login
 */
function logout() {
    const session = getSession();
    if (session) {
        // Log the logout
        logAudit(session.userId, 'LOGOUT', null, 'User logged out');
    }
    clearSession();
    redirectToLogin();
}

/**
 * Clear session data
 */
function clearSession() {
    localStorage.removeItem(SESSION_KEY);
}

/**
 * Redirect to login page
 */
function redirectToLogin() {
    window.location.href = 'login.html';
}

// ============================================================================
// PERMISSION CHECKS
// ============================================================================

/**
 * Check if current user has permission to perform action
 * Shows alert if not permitted
 * 
 * @param {string} action - Action to check (e.g., 'DELETE_ORDER')
 * @return {boolean} True if permitted
 */
function canDo(action) {
    const session = getSession();
    if (!session) {
        redirectToLogin();
        return false;
    }
    
    const role = session.role;
    const allowed = hasPermission(role, action);
    
    if (!allowed) {
        showPermissionDenied(action);
    }
    
    return allowed;
}

/**
 * Permission matrix (client-side check)
 * Must match server-side permissions in Apps Script
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
            // Owner can do everything
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

/**
 * Show permission denied message
 */
function showPermissionDenied(action) {
    const session = getSession();
    const role = session ? session.role : 'Unknown';
    
    alert(`Permission Denied\n\nYour role (${role}) does not have permission to: ${action}\n\nContact an administrator if you need access.`);
}

// ============================================================================
// ROLE-BASED UI
// ============================================================================

/**
 * Hide/show elements based on user role
 * Call this after page loads
 */
function applyRoleBasedUI() {
    const session = getSession();
    if (!session) {
        redirectToLogin();
        return;
    }
    
    const role = session.role;
    
    // Show role indicator in header
    showRoleIndicator(role, session.username);
    
    // Apply role-specific UI changes
    switch (role) {
        case 'KITCHEN':
            applyKitchenUI();
            break;
        case 'SERVER':
            applyServerUI();
            break;
        case 'ADMIN':
            applyAdminUI();
            break;
        case 'OWNER':
            applyOwnerUI();
            break;
    }
}

/**
 * Show role indicator in header
 */
function showRoleIndicator(role, username) {
    // Create role badge
    const roleBadge = document.createElement('div');
    roleBadge.id = 'roleBadge';
    roleBadge.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 8px 15px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 600;
        z-index: 9999;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        gap: 10px;
    `;
    
    const roleColors = {
        'KITCHEN': '#FF6B6B',
        'SERVER': '#4ECDC4',
        'ADMIN': '#FFD93D',
        'OWNER': '#6BCB77'
    };
    
    roleBadge.innerHTML = `
        <span style="background: ${roleColors[role]}; width: 8px; height: 8px; border-radius: 50%; display: inline-block;"></span>
        <span>${role}: ${username}</span>
        <button onclick="logout()" style="background: rgba(255,255,255,0.2); border: none; color: white; padding: 4px 8px; border-radius: 10px; cursor: pointer; font-size: 11px;">Logout</button>
    `;
    
    document.body.appendChild(roleBadge);
}

/**
 * Apply Kitchen-specific UI
 */
function applyKitchenUI() {
    // Hide elements Kitchen shouldn't see
    hideElements([
        '.delete-btn',
        '.edit-btn',
        '.cancel-btn',
        '#paymentSection',
        '#statsSection',
        '#menuManagerLink',
        '#bulkActions',
        '[data-filter="completed"]'  // Hide completed filter
    ]);
    
    // Show only relevant filters
    showOnlyFilters(['new', 'preparing', 'ready']);
}

/**
 * Apply Server-specific UI
 */
function applyServerUI() {
    // Hide elements Server shouldn't see
    hideElements([
        '.delete-btn',
        '#menuManagerLink',
        '#bulkActions'
    ]);
    
    // Disable edit button for non-NEW orders
    disableEditForNonNewOrders();
}

/**
 * Apply Admin-specific UI
 */
function applyAdminUI() {
    // Admin sees everything - no hiding needed
    // Menu manager link visible
    // Delete buttons visible
}

/**
 * Apply Owner-specific UI
 */
function applyOwnerUI() {
    // Owner sees everything - same as Admin for now
    // Future: Add owner-only sections
}

/**
 * Hide elements by selector
 */
function hideElements(selectors) {
    selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
            el.style.display = 'none';
        });
    });
}

/**
 * Show only specific filter tabs
 */
function showOnlyFilters(allowedFilters) {
    const allFilters = document.querySelectorAll('[data-filter]');
    allFilters.forEach(filter => {
        const filterName = filter.getAttribute('data-filter');
        if (!allowedFilters.includes(filterName)) {
            filter.style.display = 'none';
        }
    });
}

/**
 * Disable edit button for orders that are not NEW
 */
function disableEditForNonNewOrders() {
    // This function should be called when rendering each order card
    // It's implemented in the main admin script
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

/**
 * Log an action to audit trail
 */
async function logAudit(userId, action, target, details) {
    try {
        const url = `${API_URL}?action=logAudit&userId=${encodeURIComponent(userId)}&action=${encodeURIComponent(action)}&target=${encodeURIComponent(target || '')}&details=${encodeURIComponent(details || '')}`;
        await fetch(url);
    } catch (error) {
        console.error('Audit log error:', error);
    }
}

/**
 * Log with current session user
 */
async function logAction(action, target, details) {
    const session = getSession();
    if (session) {
        await logAudit(session.userId, action, target, details);
    }
}

// ============================================================================
// AUTO-LOGOUT TIMER
// ============================================================================

let inactivityTimer;

/**
 * Reset inactivity timer
 */
function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    
    // Show warning at 28 minutes
    const warningTimer = setTimeout(() => {
        const remaining = 2; // 2 minutes left
        if (confirm(`Your session will expire in ${remaining} minutes due to inactivity.\n\nClick OK to stay logged in.`)) {
            refreshSession();
            resetInactivityTimer();
        }
    }, 28 * 60 * 1000);
    
    // Auto-logout at 30 minutes
    inactivityTimer = setTimeout(() => {
        alert('You have been logged out due to inactivity.');
        logout();
    }, SESSION_TIMEOUT);
}

// Track user activity
['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
    document.addEventListener(event, resetInactivityTimer, true);
});

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize session management
 * Call this when page loads
 */
function initSessionManagement() {
    // Check session on page load
    const session = checkSession();
    if (!session) return;
    
    // Apply role-based UI
    applyRoleBasedUI();
    
    // Start inactivity timer
    resetInactivityTimer();
    
    console.log(`Session initialized for ${session.username} (${session.role})`);
}

// Auto-initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSessionManagement);
} else {
    initSessionManagement();
}
