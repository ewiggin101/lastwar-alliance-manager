const API_URL = '/api/train-schedules';
const MEMBERS_URL = '/api/members';
const MEMBER_STATS_URL = '/api/members/stats';

let currentWeekStart = null;
let allMembers = [];
let memberStats = {};
let backupMembers = [];
let schedules = {};
let allHistory = [];
let currentUsername = '';
let currentUserRank = '';
let isAdmin = false;
let vipSeatEnabled = true;
let scheduleViewMode = localStorage.getItem('trainViewMode') || 'cards';

// Return member nickname or null by member ID from allMembers
function nickByID(id) {
    if (!id) return null;
    const m = allMembers.find(m => m.id === id);
    return m ? (m.nickname || null) : null;
}

// Render name + optional nickname span
function nameNick(name, nick) {
    if (!nick) return escapeHtml(name);
    return `${escapeHtml(name)} <span class="member-nickname">aka ${escapeHtml(nick)}</span>`;
}

function backupDisplayName(schedule, includeRank = false) {
    if (!schedule || !schedule.backup_id) {
        return '<span class="backup-none">No backup assigned</span>';
    }

    const name = nameNick(schedule.backup_name || '[Removed Member]', nickByID(schedule.backup_id));
    return includeRank && schedule.backup_rank
        ? `${name} (${escapeHtml(schedule.backup_rank)})`
        : name;
}

function setMeritPoolCollapsed(collapsed) {
    const toggle = document.getElementById('merit-pool-toggle');
    const content = document.getElementById('merit-pool-content');
    if (!toggle || !content) return;

    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Expand merit pool' : 'Minimize merit pool';
    const label = toggle.querySelector('.merit-pool-toggle-label');
    if (label) {
        label.innerHTML = `${collapsed ? 'Expand' : 'Minimize'} <span aria-hidden="true">${collapsed ? '&gt;' : 'v'}</span>`;
    }
    localStorage.setItem('meritPoolCollapsed', String(collapsed));
}

function initMeritPoolToggle() {
    const toggle = document.getElementById('merit-pool-toggle');
    if (!toggle) return;

    const collapsed = localStorage.getItem('meritPoolCollapsed') === 'true';
    setMeritPoolCollapsed(collapsed);
    toggle.addEventListener('click', () => {
        const content = document.getElementById('merit-pool-content');
        setMeritPoolCollapsed(!content.hidden);
    });
}

async function refreshMeritTHP() {
    const button = document.getElementById('refresh-merit-thp-btn');
    const status = document.getElementById('merit-pool-refresh-status');
    if (!button) return;

    setButtonLoading(button, 'Refreshing...');
    if (status) status.textContent = '';

    try {
        const response = await fetch('/api/merit-pool/refresh', { method: 'POST' });
        if (!response.ok) {
            throw new Error((await response.text()) || 'Failed to refresh Merit THP');
        }

        const result = await response.json();
        await loadMembers();

        const summary = [
            `${result.updated_count} updated`,
            `${result.unchanged_count} unchanged`
        ];
        if (result.unmatched_count) summary.push(`${result.unmatched_count} unmatched`);
        if (result.no_thp_count) summary.push(`${result.no_thp_count} missing THP`);

        const unmatched = (result.members || [])
            .filter(member => member.status === 'unmatched')
            .map(member => member.local_name);
        if (status) {
            status.textContent = summary.join(' · ') + (unmatched.length ? `: ${unmatched.join(', ')}` : '');
        }
        showToast(result.message, 'success');
    } catch (error) {
        console.error('Error refreshing Merit THP:', error);
        if (status) status.textContent = error.message;
        showToast(`Failed to refresh Merit THP: ${error.message}`, 'error');
    } finally {
        clearButtonLoading(button);
    }
}

function initMeritTHPRefresh() {
    const button = document.getElementById('refresh-merit-thp-btn');
    if (!button) return;
    if (!canEditSchedule()) {
        button.style.display = 'none';
        return;
    }
    button.addEventListener('click', refreshMeritTHP);
}

// Check authentication on page load
async function checkAuth() {
    try {
        const response = await fetch('/api/check-auth');
        const data = await response.json();
        
        if (!data.authenticated) {
            window.location.href = '/login.html';
            return false;
        }
        if (data.must_change_password) { window.location.href = '/profile.html?must_change_password=1'; return false; }
        
        currentUsername = data.username;
        currentUserRank = data.rank || '';
        isAdmin = data.is_admin || false;
        
        let displayText = `👤 ${currentUsername}`;
        if (data.rank) {
            displayText += ` (${data.rank})`;
        }
        document.getElementById('username-display').textContent = displayText;
        
        return true;
    } catch (error) {
        console.error('Auth check error:', error);
        window.location.href = '/login.html';
        return false;
    }
}

// Check if user can edit train schedules (R4, R5, or admin)
function canEditSchedule() {
    return isAdmin || currentUserRank === 'R4' || currentUserRank === 'R5';
}

function isMeritMember(member) {
    return member.merit_eligible === true || member.merit_eligible === 1 || member.merit_eligible === '1';
}

// Setup event listeners after auth check
async function setupEventListeners() {
    const usernameDisplay = document.getElementById('username-display');
    const logoutBtn = document.getElementById('dropdown-logout-btn');
    const adminLink = document.getElementById('admin-dropdown-link');
    
    if (usernameDisplay) {
        usernameDisplay.addEventListener('click', toggleUserDropdown);
    }
    
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // Check if user is admin to show admin link
    try {
        const response = await fetch('/api/check-auth');
        const data = await response.json();
        if (data.is_admin && adminLink) {
            adminLink.style.display = 'block';
        }
    } catch (error) {
        console.error('Error checking admin status:', error);
    }
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (event) => {
        const dropdown = document.getElementById('user-dropdown-menu');
        const usernameBtn = document.getElementById('username-display');
        if (dropdown && usernameBtn && !usernameBtn.contains(event.target) && !dropdown.contains(event.target)) {
            dropdown.classList.remove('show');
        }
    });
}

// Toggle user dropdown menu
function toggleUserDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('user-dropdown-menu');
    if (dropdown) {
        dropdown.classList.toggle('show');
    }
}

// Logout handler
async function handleLogout(event) {
    event.preventDefault();
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/login.html';
    }
}

// Get Monday of current week
function getMondayOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    return new Date(d.setDate(diff));
}

// Format date as YYYY-MM-DD
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Format date for display (European style: dd/mm/yyyy)
function formatDisplayDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    
    return `${days[date.getDay()]}, ${day}/${month}/${year}`;
}

// Initialize current week
function initializeWeek() {
    currentWeekStart = getMondayOfWeek(new Date());
    updateWeekDisplay();
}

// Update week display
function updateWeekDisplay() {
    const endDate = new Date(currentWeekStart);
    endDate.setDate(endDate.getDate() + 6);
    
    const startMonth = currentWeekStart.toLocaleString('default', { month: 'long' });
    const endMonth = endDate.toLocaleString('default', { month: 'long' });
    const year = currentWeekStart.getFullYear();
    
    let displayText;
    if (startMonth === endMonth) {
        displayText = `Week of ${startMonth} ${currentWeekStart.getDate()}-${endDate.getDate()}, ${year}`;
    } else {
        displayText = `Week of ${startMonth} ${currentWeekStart.getDate()} - ${endMonth} ${endDate.getDate()}, ${year}`;
    }
    
    document.getElementById('week-display').textContent = displayText;
}

// Navigate weeks
document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    updateWeekDisplay();
    loadSchedules();
    hideWeeklyMessage();
});

document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    updateWeekDisplay();
    loadSchedules();
    hideWeeklyMessage();
});

document.getElementById('today-week-btn').addEventListener('click', () => {
    currentWeekStart = getMondayOfWeek(new Date());
    updateWeekDisplay();
    loadSchedules();
    hideWeeklyMessage();
});

// Hide weekly message section
function hideWeeklyMessage() {
    document.getElementById('weekly-message-section').style.display = 'none';
}

// Dismiss button handlers for message sections
document.getElementById('dismiss-weekly-btn').addEventListener('click', () => {
    document.getElementById('weekly-message-section').style.display = 'none';
});
document.getElementById('dismiss-daily-btn').addEventListener('click', () => {
    document.getElementById('daily-message-section').style.display = 'none';
});
document.getElementById('dismiss-conductor-btn').addEventListener('click', () => {
    document.getElementById('conductor-messages-section').style.display = 'none';
});

// Generate weekly message (will be setup in init if user has permission)
async function generateWeeklyMessage() {
    const startDate = formatDate(currentWeekStart);
    
    try {
        const response = await fetch(`/api/train-schedules/weekly-message?start=${startDate}`);
        if (!response.ok) throw new Error('Failed to generate message');
        
        const data = await response.json();
        document.getElementById('weekly-message').value = data.message;
        document.getElementById('weekly-message-section').style.display = 'block';
        
        // Scroll to message
        document.getElementById('weekly-message-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
        console.error('Error generating message:', error);
        showToast('Failed to generate weekly message', 'error');
    }
}

// Copy message to clipboard
document.getElementById('copy-message-btn').addEventListener('click', () => {
    const messageText = document.getElementById('weekly-message');
    messageText.select();
    document.execCommand('copy');
    
    // Visual feedback
    const btn = document.getElementById('copy-message-btn');
    const originalText = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => {
        btn.textContent = originalText;
    }, 2000);
});

// Generate daily message (will be setup in init if user has permission)
function showDailyMessageSection() {
    // Show the daily message section with date picker
    document.getElementById('daily-message-section').style.display = 'block';
    
    // Set default date to today
    const today = new Date();
    document.getElementById('daily-message-date').value = formatDate(today);
    
    // Scroll to message section
    document.getElementById('daily-message-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Load daily message for selected date
document.getElementById('load-daily-message-btn').addEventListener('click', async () => {
    const dateInput = document.getElementById('daily-message-date').value;
    if (!dateInput) {
        showToast('Please select a date', 'warning');
        return;
    }
    
    try {
        const response = await fetch(`/api/train-schedules/daily-message?date=${dateInput}`);
        if (!response.ok) {
            if (response.status === 404) {
                showToast('No schedule found for this date. Please create a schedule first.', 'warning');
            } else {
                throw new Error('Failed to generate message');
            }
            return;
        }
        
        const data = await response.json();
        document.getElementById('daily-message').value = data.message;
    } catch (error) {
        console.error('Error generating daily message:', error);
        showToast('Failed to generate daily message', 'error');
    }
});

// Copy daily message to clipboard
document.getElementById('copy-daily-message-btn').addEventListener('click', () => {
    const messageText = document.getElementById('daily-message');
    messageText.select();
    document.execCommand('copy');
    
    // Visual feedback
    const btn = document.getElementById('copy-daily-message-btn');
    const originalText = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => {
        btn.textContent = originalText;
    }, 2000);
});

// Generate conductor reminder messages (will be setup in init if user has permission)
async function generateConductorMessages() {
    const startDate = formatDate(currentWeekStart);
    
    try {
        const response = await fetch(`/api/train-schedules/conductor-messages?start=${startDate}`);
        if (!response.ok) throw new Error('Failed to generate conductor messages');
        
        const data = await response.json();
        
        // Display messages
        const messagesContainer = document.getElementById('conductor-messages-list');
        messagesContainer.innerHTML = '';
        
        data.messages.forEach((msg, index) => {
            const messageCard = document.createElement('div');
            messageCard.className = 'conductor-message-card';
            messageCard.innerHTML = `
                <div class="conductor-message-header">
                    <strong>${msg.day} – ${msg.name}</strong>
                </div>
                <div class="conductor-message-content">
                    <textarea readonly rows="4" id="conductor-msg-${index}">${msg.message}</textarea>
                </div>
                <button class="copy-btn copy-conductor-msg" data-index="${index}">📋 Copy Message</button>
            `;
            messagesContainer.appendChild(messageCard);
        });
        
        // Show section
        document.getElementById('conductor-messages-section').style.display = 'block';
        
        // Scroll to messages
        document.getElementById('conductor-messages-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        
        // Add event listeners to copy buttons
        document.querySelectorAll('.copy-conductor-msg').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = e.target.dataset.index;
                const textarea = document.getElementById(`conductor-msg-${index}`);
                textarea.select();
                document.execCommand('copy');
                
                // Visual feedback
                const originalText = e.target.textContent;
                e.target.textContent = '✅ Copied!';
                setTimeout(() => {
                    e.target.textContent = originalText;
                }, 2000);
            });
        });
        
    } catch (error) {
        console.error('Error generating conductor messages:', error);
        showToast('Failed to generate conductor reminder messages', 'error');
    }
}

// Load members
async function loadMembers() {
    try {
        const response = await fetch(MEMBERS_URL);
        allMembers = await response.json();
        // Sort members case-insensitively by name
        allMembers.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        backupMembers = allMembers.filter(m => m.rank === 'R4' || m.rank === 'R5');
        renderMeritPool();
        
        // Load member statistics
        await loadMemberStats();
    } catch (error) {
        console.error('Error loading members:', error);
    }
}

function renderMeritPool() {
    const list = document.getElementById('merit-pool-list');
    const count = document.getElementById('merit-pool-count');
    if (!list || !count) return;

    const meritMembers = allMembers
        .filter(isMeritMember)
        .sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || a.name.localeCompare(b.name));

    count.textContent = `${meritMembers.length}/12 selected`;

    if (meritMembers.length === 0) {
        list.innerHTML = '<p class="empty">No members are in the merit pool. Mark members as Merit THP on the Members page.</p>';
        return;
    }

    const hasRecordedPower = meritMembers.some(member => Number(member.power) > 0);
    const rows = meritMembers.map((member, index) => {
        const power = Number(member.power) || 0;
        const powerText = power > 0 ? `${power.toLocaleString()} THP` : '&mdash;';
        return `
            <tr>
                <td class="merit-pool-position">${index + 1}</td>
                <td class="merit-pool-name">${nameNick(member.name, member.nickname)}</td>
                <td><span class="merit-pool-rank">${escapeHtml(member.rank)}</span></td>
                <td class="merit-pool-power">${powerText}</td>
            </tr>
        `;
    }).join('');

    list.innerHTML = `
        <div class="merit-pool-table-wrap">
            <table class="merit-pool-table">
                <thead>
                    <tr>
                        <th scope="col">#</th>
                        <th scope="col">Member</th>
                        <th scope="col">Rank</th>
                        <th scope="col">THP</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        ${hasRecordedPower ? '' : '<p class="merit-pool-note">THP is not recorded for these members yet.</p>'}
    `;
}

// Load member statistics
async function loadMemberStats() {
    try {
        const response = await fetch(MEMBER_STATS_URL);
        const stats = await response.json();
        
        // Convert to object keyed by member ID for easy lookup
        memberStats = {};
        stats.forEach(stat => {
            memberStats[stat.id] = stat;
        });
    } catch (error) {
        console.error('Error loading member stats:', error);
    }
}

// Load schedules for current week
async function loadSchedules() {
    const startDate = formatDate(currentWeekStart);
    const endDate = new Date(currentWeekStart);
    endDate.setDate(endDate.getDate() + 6);
    const endDateStr = formatDate(endDate);
    
    try {
        const response = await fetch(`${API_URL}?start=${startDate}&end=${endDateStr}`);
        const data = await response.json();
        
        schedules = {};
        data.forEach(schedule => {
            schedules[schedule.date] = schedule;
        });
        
        renderSchedule();
    } catch (error) {
        console.error('Error loading schedules:', error);
        document.getElementById('schedule-grid').innerHTML = 
            '<p class="empty">⚠️ Supply route data corrupted. Retry the mission.</p>';
    }
}

// Render schedule in the active view mode
function renderSchedule() {
    if (scheduleViewMode === 'list') {
        renderScheduleList();
    } else {
        renderScheduleGrid();
    }
}

// Render compact list/table view
function renderScheduleList() {
    const grid = document.getElementById('schedule-grid');
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    
    let html = '<table class="schedule-list-table"><thead><tr>';
    html += '<th>Day</th><th>Conductor</th><th>Backup</th>';
    if (vipSeatEnabled) html += '<th>VIP</th>';
    html += '<th>Status</th>';
    if (canEditSchedule()) html += '<th></th>';
    html += '</tr></thead><tbody>';
    
    for (let i = 0; i < 7; i++) {
        const date = new Date(currentWeekStart);
        date.setDate(date.getDate() + i);
        const dateStr = formatDate(date);
        const schedule = schedules[dateStr];
        const isPast = date < new Date(new Date().setHours(0, 0, 0, 0));
        
        html += `<tr class="${isPast ? 'past-row' : ''}">`;
        html += `<td class="list-day-cell"><strong>${days[i]}</strong> <span class="list-date">${date.getDate()}/${date.getMonth() + 1}</span></td>`;
        
        if (schedule) {
            html += `<td>${nameNick(schedule.conductor_name, nickByID(schedule.conductor_id))}`;
            if (schedule.conductor_score != null) html += ` <span class="score-badge">${schedule.conductor_score}</span>`;
            html += `</td>`;
            html += `<td>${backupDisplayName(schedule)}`;
            if (schedule.conductor_showed_up === false) {
                html += schedule.actual_conductor_id
                    ? ` <span class="status-badge info">→ ${nameNick(schedule.actual_conductor_name, nickByID(schedule.actual_conductor_id))}</span>`
                    : ' <span class="status-badge active">🚂</span>';
            }
            html += `</td>`;
            if (vipSeatEnabled) html += `<td>${schedule.vip_name ? nameNick(schedule.vip_name, nickByID(schedule.vip_id)) : '—'}</td>`;
            
            let statusHtml = '';
            if (schedule.conductor_showed_up === true) statusHtml = '<span class="status-badge success">✓</span>';
            else if (schedule.conductor_showed_up === false) statusHtml = '<span class="status-badge warning">✗</span>';
            else statusHtml = '<span class="status-badge info">—</span>';
            html += `<td>${statusHtml}</td>`;
            
            if (canEditSchedule()) {
                html += `<td class="list-actions"><button class="edit-schedule-btn" onclick="editSchedule('${dateStr}')">✏️</button> <button class="clear-schedule-btn" onclick="clearSchedule(${schedule.id}, '${dateStr}')">🗑️</button></td>`;
            }
        } else {
            const emptySpan = vipSeatEnabled ? 3 : 2;
            html += `<td colspan="${emptySpan}" class="list-empty">Not scheduled</td>`;
            html += `<td>—</td>`;
            if (canEditSchedule()) {
                html += `<td class="list-actions"><button class="schedule-btn" onclick="openScheduleModal('${dateStr}')">✏️</button></td>`;
            }
        }
        html += '</tr>';
    }
    
    html += '</tbody></table>';
    grid.innerHTML = html;
}

// Render schedule card grid
function renderScheduleGrid() {
    const grid = document.getElementById('schedule-grid');
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    
    let html = '';
    
    for (let i = 0; i < 7; i++) {
        const date = new Date(currentWeekStart);
        date.setDate(date.getDate() + i);
        const dateStr = formatDate(date);
        const schedule = schedules[dateStr];
        const isPast = date < new Date(new Date().setHours(0, 0, 0, 0));
        
        html += `<div class="day-card ${isPast ? 'past' : ''}">`;
        html += `<div class="day-header">`;
        html += `<h4>${days[i]}</h4>`;
        html += `<div class="day-date">${date.getDate()}/${date.getMonth() + 1}</div>`;
        html += `</div>`;
        
        if (schedule) {
            const showedUpClass = schedule.conductor_showed_up === null ? '' : 
                                schedule.conductor_showed_up ? 'success' : 'warning';
            
            html += `<div class="schedule-info ${showedUpClass}">`;
            html += `<div class="conductor">`;
            html += `<strong>Conductor:</strong><br>${nameNick(schedule.conductor_name, nickByID(schedule.conductor_id))}`;
            if (schedule.conductor_score !== null && schedule.conductor_score !== undefined) {
                html += ` <span class="score-badge">${schedule.conductor_score} pts</span>`;
            }
            if (schedule.conductor_showed_up !== null) {
                html += schedule.conductor_showed_up ? 
                    ' <span class="status-badge success">✓ Showed up</span>' :
                    ' <span class="status-badge warning">✗ Absent</span>';
            }
            html += `</div>`;
            html += `<div class="backup">`;
            html += `<strong>Backup:</strong><br>${backupDisplayName(schedule, true)}`;
            if (schedule.conductor_showed_up === false) {
                if (schedule.actual_conductor_id) {
                    // Backup assigned to someone else
                    html += ' <span class="status-badge info">📋 Assigned to:</span>';
                    html += `<br><strong>${nameNick(schedule.actual_conductor_name, nickByID(schedule.actual_conductor_id))}</strong>`;
                } else if (schedule.backup_id) {
                    // Backup conducted it themselves
                    html += ' <span class="status-badge active">🚂 Stepped in</span>';
                }
            }
            html += `</div>`;
            if (vipSeatEnabled && schedule.vip_name) {
                html += `<div class="vip-seat"><strong>VIP:</strong> ${nameNick(schedule.vip_name, nickByID(schedule.vip_id))}</div>`;
            }
            if (schedule.notes) {
                html += `<div class="notes"><strong>Notes:</strong> ${escapeHtml(schedule.notes)}</div>`;
            }
            if (canEditSchedule()) {
                html += `<div class="schedule-actions">`;
                html += `<button class="edit-schedule-btn" onclick="editSchedule('${dateStr}')">✏️ Edit</button>`;
                html += `<button class="clear-schedule-btn" onclick="clearSchedule(${schedule.id}, '${dateStr}')">🗑️ Clear</button>`;
                html += `</div>`;
            }
            html += `</div>`;
        } else {
            html += `<div class="no-schedule">`;
            html += `<p>Not scheduled</p>`;
            if (canEditSchedule()) {
                html += `<div class="schedule-actions">`;
                html += `<button class="schedule-btn" onclick="openScheduleModal('${dateStr}')">✏️ Schedule</button>`;
                html += `</div>`;
            }
            html += `</div>`;
        }
        
        html += `</div>`;
    }
    
    grid.innerHTML = html;
}

// Open schedule modal
function openScheduleModal(dateStr) {
    if (!canEditSchedule()) {
        showToast('Only R4, R5 ranks and admins can edit the train schedule.', 'warning');
        return;
    }
    
    const modal = document.getElementById('schedule-modal');
    const form = document.getElementById('schedule-form');
    const schedule = schedules[dateStr];
    
    // Reset form
    form.reset();
    document.getElementById('schedule-id').value = schedule ? schedule.id : '';
    document.getElementById('schedule-date').value = dateStr;
    document.getElementById('display-date').textContent = formatDisplayDate(dateStr);
    
    // Reset search inputs
    document.getElementById('conductor-search').value = '';
    document.getElementById('backup-search').value = '';
    document.getElementById('vip-search').value = '';
    document.getElementById('actual-conductor-search').value = '';
    
    // Populate conductor select
    populateConductorSelect(allMembers, schedule);
    
    // Populate backup select (R4 and R5 only)
    populateBackupSelect(backupMembers, schedule);

    // Populate VIP select (all active members)
    populateVipSelect(allMembers, schedule);

    // Show "Next in rotation" hint near backup select (only for new schedules)
    if (!schedule) {
        fetchAndShowRotationHint();
    } else {
        const hint = document.getElementById('rotation-hint');
        if (hint) hint.style.display = 'none';
    }
    
    // Populate actual conductor select (all members)
    populateActualConductorSelect(allMembers, schedule);
    
    // Setup search filters
    setupDropdownSearch();
    
    // Show/hide attendance group
    const attendanceGroup = document.getElementById('attendance-group');
    const actualConductorGroup = document.getElementById('actual-conductor-group');
    const actualConductorSelectGroup = document.getElementById('actual-conductor-select-group');
    const dateObj = new Date(dateStr + 'T00:00:00');
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    const isNotFuture = dateObj <= today;
    
    // Hide actual conductor groups by default
    actualConductorGroup.style.display = 'none';
    actualConductorSelectGroup.style.display = 'none';
    
    if (isNotFuture && schedule) {
        attendanceGroup.style.display = 'block';
        if (schedule.conductor_showed_up !== null) {
            document.querySelector(`input[name="attendance"][value="${schedule.conductor_showed_up ? 'yes' : 'no'}"]`).checked = true;
            
            // If conductor didn't show up, show actual conductor options
            if (schedule.conductor_showed_up === false) {
                actualConductorGroup.style.display = 'block';
                if (schedule.actual_conductor_id) {
                    // Someone else was assigned
                    document.querySelector('input[name="actual-conductor-option"][value="other"]').checked = true;
                    actualConductorSelectGroup.style.display = 'block';
                } else {
                    // Backup conducted it
                    document.querySelector('input[name="actual-conductor-option"][value="backup"]').checked = true;
                }
            }
        }
    } else {
        attendanceGroup.style.display = 'none';
    }
    
    // Set notes
    if (schedule && schedule.notes) {
        document.getElementById('notes').value = schedule.notes;
    }
    
    // Setup attendance change handler
    setupAttendanceHandlers();
    
    // Save button: enable only when a conductor is selected
    const submitBtn = document.getElementById('modal-submit');
    const conductorSelect = document.getElementById('conductor-select');
    const updateSubmitState = () => {
        submitBtn.disabled = !conductorSelect.value;
    };
    updateSubmitState();
    conductorSelect.addEventListener('change', updateSubmitState);
    
    document.getElementById('modal-title').textContent = schedule ? 'Edit Schedule' : 'Schedule Train';
    modal.style.display = 'flex';
}

// Populate conductor select
function populateConductorSelect(members, schedule) {
    const conductorSelect = document.getElementById('conductor-select');
    conductorSelect.innerHTML = '';
    
    members.forEach(member => {
        const option = document.createElement('option');
        option.value = member.id;
        
        // Build option text with stats
        let optionText = `${member.name}${member.nickname ? ' [' + member.nickname + ']' : ''} (${member.rank})`;
        if (isMeritMember(member)) optionText += ' - Merit THP';
        const stats = memberStats[member.id];
        if (stats) {
            const statsInfo = [];
            if (stats.conductor_count > 0) {
                statsInfo.push(`${stats.conductor_count}x conductor`);
            }
            if (stats.conductor_no_show_count > 0) {
                statsInfo.push(`⚠️ ${stats.conductor_no_show_count}x unreliable`);
            }
            if (stats.backup_used_count > 0) {
                statsInfo.push(`${stats.backup_used_count}x backup used`);
            }
            if (stats.last_conductor_date) {
                const lastDate = new Date(stats.last_conductor_date + 'T00:00:00');
                const day = String(lastDate.getDate()).padStart(2, '0');
                const month = String(lastDate.getMonth() + 1).padStart(2, '0');
                const year = lastDate.getFullYear();
                statsInfo.push(`last: ${day}/${month}/${year}`);
            }
            if (statsInfo.length > 0) {
                optionText += ` - ${statsInfo.join(', ')}`;
            }
        }
        
        option.textContent = optionText;
        option.dataset.name = (member.name + (member.nickname ? ' ' + member.nickname : '')).toLowerCase();
        option.dataset.rank = member.rank.toLowerCase();
        if (schedule && member.id === schedule.conductor_id) {
            option.selected = true;
        }
        conductorSelect.appendChild(option);
    });
}

// Populate backup select
function populateBackupSelect(members, schedule) {
    const backupSelect = document.getElementById('backup-select');
    backupSelect.innerHTML = '';

    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '— No backup assigned —';
    noneOption.selected = !schedule || !schedule.backup_id;
    backupSelect.appendChild(noneOption);
    
    members.forEach(member => {
        const option = document.createElement('option');
        option.value = member.id;
        
        // Build option text with stats
        let optionText = member.name + (member.nickname ? ' [' + member.nickname + ']' : '');
        const stats = memberStats[member.id];
        if (stats && stats.backup_used_count > 0) {
            optionText += ` (used as backup ${stats.backup_used_count}x)`;
        }
        if (isMeritMember(member)) optionText += ' (Merit THP)';
        
        option.textContent = optionText;
        option.dataset.name = (member.name + (member.nickname ? ' ' + member.nickname : '')).toLowerCase();
        if (schedule && member.id === schedule.backup_id) {
            option.selected = true;
        }
        backupSelect.appendChild(option);
    });
}

// Apply VIP seat visibility based on the vipSeatEnabled setting
function applyVipSeatVisibility() {
    const drawVipBtn = document.getElementById('draw-vip-btn');
    if (drawVipBtn) drawVipBtn.style.display = vipSeatEnabled ? '' : 'none';
}

// Populate VIP select (merit members stay out of the flex/VIP lane)
function populateVipSelect(members, schedule) {
    // Hide/show the VIP form group based on setting
    const vipFormGroup = document.getElementById('vip-search') && document.getElementById('vip-search').closest('.form-group');
    if (vipFormGroup) vipFormGroup.style.display = vipSeatEnabled ? '' : 'none';
    if (!vipSeatEnabled) return;

    const vipSelect = document.getElementById('vip-select');
    vipSelect.innerHTML = '<option value="">— No VIP assigned —</option>';

    const currentVip = schedule && allMembers.find(member => member.id === schedule.vip_id);
    const selectableMembers = members.filter(member =>
        !isMeritMember(member) || (currentVip && member.id === currentVip.id)
    );

    selectableMembers.forEach(member => {
        const option = document.createElement('option');
        option.value = member.id;
        let optionText = `${member.name}${member.nickname ? ' [' + member.nickname + ']' : ''} (${member.rank})`;
        if (isMeritMember(member)) optionText += ' (Merit THP - existing)';
        option.textContent = optionText;
        option.dataset.name = (member.name + (member.nickname ? ' ' + member.nickname : '')).toLowerCase();
        if (schedule && schedule.vip_id && member.id === schedule.vip_id) {
            option.selected = true;
        }
        vipSelect.appendChild(option);
    });
}

// Populate actual conductor select (shown when backup assigns to someone else)
async function fetchAndShowRotationHint() {
    const hint = document.getElementById('rotation-hint');
    if (!hint) return;
    try {
        const res = await fetch('/api/settings/backup-rotation');
        if (!res.ok) { hint.style.display = 'none'; return; }
        const data = await res.json();
        if (data.members && data.members.length > 0) {
        hint.textContent = `🔄 Next in rotation: ${data.members[0].name}${data.members[0].nickname ? ' [' + data.members[0].nickname + ']' : ''} (${data.members[0].rank})`;
            hint.style.display = 'block';
        } else {
            hint.style.display = 'none';
        }
    } catch {
        hint.style.display = 'none';
    }
}

function populateActualConductorSelect(members, schedule) {
    const actualConductorSelect = document.getElementById('actual-conductor-select');
    actualConductorSelect.innerHTML = '';
    
    members.forEach(member => {
        const option = document.createElement('option');
        option.value = member.id;
        
        // Build option text with stats
        let optionText = `${member.name}${member.nickname ? ' [' + member.nickname + ']' : ''} (${member.rank})`;
        const stats = memberStats[member.id];
        if (stats && stats.actual_conductor_count > 0) {
            optionText += ` - assigned ${stats.actual_conductor_count}x`;
        }
        
        option.textContent = optionText;
        option.dataset.name = (member.name + (member.nickname ? ' ' + member.nickname : '')).toLowerCase();
        if (schedule && schedule.actual_conductor_id && member.id === schedule.actual_conductor_id) {
            option.selected = true;
        }
        actualConductorSelect.appendChild(option);
    });
}

// Setup handlers for attendance radio buttons
function setupAttendanceHandlers() {
    const attendanceRadios = document.querySelectorAll('input[name="attendance"]');
    const actualConductorGroup = document.getElementById('actual-conductor-group');
    const actualConductorSelectGroup = document.getElementById('actual-conductor-select-group');
    const actualConductorOptionRadios = document.querySelectorAll('input[name="actual-conductor-option"]');
    
    // Handle attendance change
    attendanceRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === 'no') {
                // Conductor didn't show up - show who conducted options
                actualConductorGroup.style.display = 'block';
                // Default to backup conducted it
                if (!document.querySelector('input[name="actual-conductor-option"]:checked')) {
                    document.querySelector('input[name="actual-conductor-option"][value="backup"]').checked = true;
                }
            } else {
                // Conductor showed up - hide actual conductor options
                actualConductorGroup.style.display = 'none';
                actualConductorSelectGroup.style.display = 'none';
            }
        });
    });
    
    // Handle actual conductor option change
    actualConductorOptionRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === 'other') {
                // Show member selection dropdown
                actualConductorSelectGroup.style.display = 'block';
            } else {
                // Hide member selection dropdown
                actualConductorSelectGroup.style.display = 'none';
            }
        });
    });
}

// Setup dropdown search functionality
function setupDropdownSearch() {
    const conductorSearch = document.getElementById('conductor-search');
    const conductorSelect = document.getElementById('conductor-select');
    const backupSearch = document.getElementById('backup-search');
    const backupSelect = document.getElementById('backup-select');
    const vipSearch = document.getElementById('vip-search');
    const vipSelect = document.getElementById('vip-select');
    const actualConductorSearch = document.getElementById('actual-conductor-search');
    const actualConductorSelect = document.getElementById('actual-conductor-select');
    
    // Filter conductor dropdown
    conductorSearch.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        filterSelectOptions(conductorSelect, searchTerm);
    });
    
    // Filter backup dropdown
    backupSearch.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        filterSelectOptions(backupSelect, searchTerm);
    });

    // Filter VIP dropdown
    vipSearch.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        filterSelectOptions(vipSelect, searchTerm);
    });
    
    // Filter actual conductor dropdown
    actualConductorSearch.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        filterSelectOptions(actualConductorSelect, searchTerm);
    });
}

// Filter select options
function filterSelectOptions(selectElement, searchTerm) {
    const options = selectElement.options;
    let visibleCount = 0;
    
    for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const name = option.dataset.name || '';
        const rank = option.dataset.rank || '';
        
        if (name.includes(searchTerm) || rank.includes(searchTerm)) {
            option.style.display = '';
            visibleCount++;
        } else {
            option.style.display = 'none';
        }
    }
    
    // Auto-select if only one visible option
    if (visibleCount === 1 && searchTerm) {
        for (let i = 0; i < options.length; i++) {
            if (options[i].style.display !== 'none') {
                selectElement.selectedIndex = i;
                break;
            }
        }
    }
}

// Edit schedule
function editSchedule(dateStr) {
    if (!canEditSchedule()) {
        showToast('Only R4, R5 ranks and admins can edit the train schedule.', 'warning');
        return;
    }
    openScheduleModal(dateStr);
}

// Close modal
document.querySelector('.close').addEventListener('click', () => {
    document.getElementById('schedule-modal').style.display = 'none';
});

document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('schedule-modal').style.display = 'none';
});

// Handle form submission
document.getElementById('schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('schedule-id').value;
    const date = document.getElementById('schedule-date').value;
    const conductorId = parseInt(document.getElementById('conductor-select').value);
    const backupValue = document.getElementById('backup-select').value;
    const backupId = backupValue ? parseInt(backupValue) : 0;
    const vipSelectVal = document.getElementById('vip-select').value;
    const vipId = (vipSeatEnabled && vipSelectVal) ? parseInt(vipSelectVal) : null;
    const notes = document.getElementById('notes').value.trim() || null;
    
    const attendanceRadio = document.querySelector('input[name="attendance"]:checked');
    let conductorShowedUp = null;
    let actualConductorId = null;
    
    if (attendanceRadio) {
        conductorShowedUp = attendanceRadio.value === 'yes';
        
        // If conductor didn't show up, check who conducted it
        if (conductorShowedUp === false) {
            const actualConductorOption = document.querySelector('input[name="actual-conductor-option"]:checked');
            if (actualConductorOption && actualConductorOption.value === 'other') {
                // Backup assigned to someone else
                const actualConductorSelect = document.getElementById('actual-conductor-select');
                if (actualConductorSelect.value) {
                    actualConductorId = parseInt(actualConductorSelect.value);
                } else {
                    showToast('Please select who was assigned to conduct the train', 'warning');
                    return;
                }
            }
            // If actualConductorOption is 'backup' or not set, actualConductorId stays null (backup conducted)
        }
    }
    
    const data = {
        date,
        conductor_id: conductorId,
        backup_id: backupId,
        conductor_showed_up: conductorShowedUp,
        actual_conductor_id: actualConductorId,
        vip_id: vipId,
        notes
    };
    
    const submitBtn = document.getElementById('modal-submit');
    setButtonLoading(submitBtn, 'Saving...');
    try {
        let response;
        if (id) {
            response = await fetch(`${API_URL}/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } else {
            response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        }
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(error);
        }
        
        document.getElementById('schedule-modal').style.display = 'none';
        await loadSchedules();
        await loadHistory();
    } catch (error) {
        console.error('Error saving schedule:', error);
        showToast('Failed to save schedule: ' + error.message, 'error');
    } finally {
        clearButtonLoading(submitBtn);
    }
});

// Clear schedule for a day
async function clearSchedule(scheduleId, dateStr) {
    if (!canEditSchedule()) {
        showToast('Only R4, R5 ranks and admins can edit the train schedule.', 'warning');
        return;
    }
    
    const confirmed = await showConfirm(
        'Clear this schedule? This cannot be undone.',
        'Clear Schedule',
        'Clear',
        'Cancel',
        true
    );
    if (!confirmed) return;
    
    try {
        const response = await fetch(`${API_URL}/${scheduleId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok && response.status !== 204) {
            throw new Error('Failed to clear schedule');
        }
        
        await loadSchedules();
        await loadHistory();
    } catch (error) {
        console.error('Error clearing schedule:', error);
        showToast('Failed to clear schedule: ' + error.message, 'error');
    }
}

// Load history
async function loadHistory() {
    try {
        const response = await fetch(API_URL);
        allHistory = await response.json();
        allHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
        renderHistory('all');
    } catch (error) {
        console.error('Error loading history:', error);
        document.getElementById('history-list').innerHTML = 
            '<p class="empty">📜 War logs unavailable.</p>';
    }
}

// Render history
function renderHistory(filter) {
    let filtered = allHistory;
    
    if (filter === 'completed') {
        filtered = allHistory.filter(s => s.conductor_showed_up !== null);
    } else if (filter === 'backup') {
        filtered = allHistory.filter(s => s.conductor_showed_up === false);
    }
    
    const list = document.getElementById('history-list');
    
    if (filtered.length === 0) {
        list.innerHTML = '<p class="empty">No records found.</p>';
        return;
    }
    
    let html = '<div class="history-grid">';
    
    filtered.slice(0, 50).forEach(schedule => {
        const showedUpClass = schedule.conductor_showed_up === null ? '' : 
                            schedule.conductor_showed_up ? 'success' : 'warning';
        
        html += `<div class="history-card ${showedUpClass}">`;
        html += `<div class="history-date">${formatDisplayDate(schedule.date)}</div>`;
        html += `<div class="history-details">`;
        html += `<div><strong>Conductor:</strong> ${nameNick(schedule.conductor_name, nickByID(schedule.conductor_id))}`;
        if (schedule.conductor_showed_up !== null) {
            html += schedule.conductor_showed_up ? 
                ' <span class="status-badge success">✓</span>' :
                ' <span class="status-badge warning">✗</span>';
        }
        html += `</div>`;
        html += `<div><strong>Backup:</strong> ${backupDisplayName(schedule)}`;
        if (schedule.conductor_showed_up === false) {
            if (schedule.actual_conductor_id) {
                // Backup assigned to someone else
                html += ' <span class="status-badge info">📋 Assigned to ' + nameNick(schedule.actual_conductor_name, nickByID(schedule.actual_conductor_id)) + '</span>';
            } else if (schedule.backup_id) {
                // Backup conducted it themselves
                html += ' <span class="status-badge active">🚂 Stepped in</span>';
            }
        }
        html += `</div>`;
        if (vipSeatEnabled && schedule.vip_name) {
            html += `<div><strong>VIP:</strong> ${nameNick(schedule.vip_name, nickByID(schedule.vip_id))}</div>`;
        }
        if (schedule.notes) {
            html += `<div class="history-notes">${escapeHtml(schedule.notes)}</div>`;
        }
        html += `</div>`;
        html += `</div>`;
    });
    
    html += '</div>';
    list.innerHTML = html;
}

// History filter buttons
document.getElementById('show-all-history').addEventListener('click', function() {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    this.classList.add('active');
    renderHistory('all');
});

document.getElementById('show-completed').addEventListener('click', function() {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    this.classList.add('active');
    renderHistory('completed');
});

document.getElementById('show-backup-used').addEventListener('click', function() {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    this.classList.add('active');
    renderHistory('backup');
});

// Auto-schedule entire week
async function autoScheduleWeek() {
    // Check if any schedules exist for the current week
    const hasExistingSchedules = Object.keys(schedules).some(dateStr => schedules[dateStr]);
    
    if (hasExistingSchedules) {
        const confirmed = await showConfirm(
            'This will automatically schedule the entire week (7 days) with the top 7 performers. Existing schedules will be replaced.',
            'Auto-Schedule Week',
            'Auto-Schedule',
            'Cancel',
            false
        );
        if (!confirmed) return;
    }
    
    try {
        const response = await fetch(`${API_URL}/auto-schedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_date: formatDate(currentWeekStart) })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || 'Failed to auto-schedule week');
        }
        
        await loadSchedules();
        await loadHistory();
    } catch (error) {
        console.error('Error auto-scheduling week:', error);
        showToast('Failed to auto-schedule week: ' + error.message, 'error');
    }
}

// Escape HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---- Schedule view toggle (cards / list) ----
function initViewToggle() {
    const cardsBtn = document.getElementById('view-cards-btn');
    const listBtn = document.getElementById('view-list-btn');
    if (!cardsBtn || !listBtn) return;

    // Reflect stored preference
    if (scheduleViewMode === 'list') {
        cardsBtn.classList.remove('active');
        listBtn.classList.add('active');
    }

    cardsBtn.addEventListener('click', () => {
        scheduleViewMode = 'cards';
        localStorage.setItem('trainViewMode', 'cards');
        cardsBtn.classList.add('active');
        listBtn.classList.remove('active');
        renderSchedule();
    });
    listBtn.addEventListener('click', () => {
        scheduleViewMode = 'list';
        localStorage.setItem('trainViewMode', 'list');
        listBtn.classList.add('active');
        cardsBtn.classList.remove('active');
        renderSchedule();
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    const isAuthenticated = await checkAuth();
    if (isAuthenticated) {
        // Load settings first so vipSeatEnabled is set before rendering
        try {
            const settingsRes = await fetch('/api/settings');
            if (settingsRes.ok) {
                const s = await settingsRes.json();
                vipSeatEnabled = s.vip_seat_enabled !== undefined ? s.vip_seat_enabled : true;
            }
        } catch {}
        applyVipSeatVisibility();
        initMeritPoolToggle();
        initMeritTHPRefresh();

        await setupEventListeners();
        await loadMembers();
        initializeWeek();
        await loadSchedules();
        await loadHistory();
        await initWeekMode();
        initViewToggle();
        
        // Setup editing controls based on permissions
        if (canEditSchedule()) {
            document.getElementById('auto-schedule-week-btn').addEventListener('click', autoScheduleWeek);
            document.getElementById('generate-message-btn').addEventListener('click', generateWeeklyMessage);
            document.getElementById('generate-daily-message-btn').addEventListener('click', showDailyMessageSection);
            document.getElementById('generate-conductor-messages-btn').addEventListener('click', generateConductorMessages);
        } else {
            // Show read-only notice
            document.getElementById('read-only-notice').style.display = 'block';
            
            // Hide action buttons for read-only users
            document.querySelectorAll('.schedule-controls .action-buttons button').forEach(btn => {
                btn.style.display = 'none';
            });
        }
    }
});

// ---- Win/Save week mode ----

async function initWeekMode() {
    try {
        const res = await fetch('/api/settings/train-week-mode');
        if (!res.ok) return;
        const data = await res.json();
        applyWeekMode(data.mode || 'win');
    } catch {}

    // Radio change handler (R4/R5/admin only)
    document.querySelectorAll('input[name="week-mode"]').forEach(radio => {
        radio.addEventListener('change', async (e) => {
            if (!canEditSchedule()) return;
            try {
                const res = await fetch('/api/settings/train-week-mode', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: e.target.value })
                });
                if (!res.ok) return;
                applyWeekMode(e.target.value);
                const saved = document.getElementById('week-mode-saved');
                if (saved) {
                    saved.style.display = 'inline';
                    setTimeout(() => { saved.style.display = 'none'; }, 2000);
                }
            } catch {}
        });
    });

    // Lock mode radios for read-only users
    if (!canEditSchedule()) {
        document.querySelectorAll('input[name="week-mode"]').forEach(r => r.disabled = true);
    }

    // Lucky draw buttons
    const drawConductorBtn = document.getElementById('draw-conductor-btn');
    const drawVipBtn = document.getElementById('draw-vip-btn');
    if (drawConductorBtn) drawConductorBtn.addEventListener('click', () => runLuckyDraw('conductor'));
    if (drawVipBtn) drawVipBtn.addEventListener('click', () => runLuckyDraw('vip'));
}

function applyWeekMode(mode) {
    const winRadio = document.getElementById('mode-win');
    const saveRadio = document.getElementById('mode-save');
    const panel = document.getElementById('lucky-draw-panel');
    if (winRadio) winRadio.checked = (mode === 'win');
    if (saveRadio) saveRadio.checked = (mode === 'save');
    if (panel) panel.style.display = (mode === 'save') ? 'block' : 'none';
}

async function runLuckyDraw(type) {
    const panel = document.getElementById('draw-result');
    const weekDate = getCurrentWeekMonday();
    panel.innerHTML = '<span style="color:var(--text-muted);">🎲 Drawing...</span>';

    try {
        const res = await fetch('/api/train-schedules/lucky-draw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, week: weekDate })
        });
        const data = await res.json();

        if (!data.winner) {
            panel.innerHTML = `<span style="color:var(--text-muted);">${escapeHtml(data.message || 'No eligible members')}</span>`;
            return;
        }

        const eligibleList = (data.eligible || []).map(m => m.nickname ? escapeHtml(m.name) + ' [' + escapeHtml(m.nickname) + ']' : escapeHtml(m.name)).join(', ');
        panel.innerHTML = `
            <div style="margin-top:8px;">
                <strong>🏆 ${type === 'conductor' ? 'Conductor' : 'VIP'} Winner:</strong>
                <span style="font-size:1.1em; color:var(--accent-primary); margin-left:8px;">${nameNick(data.winner.name, data.winner.nickname)}</span>
                <span style="color:var(--text-muted); font-size:12px; margin-left:6px;">${escapeHtml(data.winner.rank)}</span>
            </div>
            <div style="margin-top:6px; font-size:12px; color:var(--text-muted);">
                Pool (${data.pool_size}): ${eligibleList}
            </div>`;
    } catch (e) {
        panel.innerHTML = `<span style="color:var(--danger-color, #e57373);">Draw failed: ${escapeHtml(e.message)}</span>`;
    }
}

function getCurrentWeekMonday() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    return monday.toISOString().split('T')[0];
}
