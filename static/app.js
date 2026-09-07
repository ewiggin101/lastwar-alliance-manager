const API_URL = '/api/members';

let editingMemberId = null;
let currentUsername = '';
let canManageRanks = false;
let isR5OrAdmin = false;
let isAdmin = false;
let allMembers = []; // Store all members for search filtering

// Modal Elements
const memberModal = document.getElementById('member-modal');
const closeMemberModal = document.getElementById('close-member-modal');
const addMemberBtn = document.getElementById('add-member-btn');
const cancelBtn = document.getElementById('cancel-btn');
const importCsvTriggerBtn = document.getElementById('import-csv-trigger-btn');
const csvImportSection = document.getElementById('csv-import-section');
const cancelImportBtn = document.getElementById('cancel-import-btn');

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
        canManageRanks = data.can_manage_ranks || false;
        isR5OrAdmin = data.is_r5_or_admin || false;
        isAdmin = data.is_admin || false;
        
        let displayText = `👤 ${currentUsername}`;
        if (data.rank) {
            displayText += ` (${data.rank})`;
        }
        
        const usernameDisplay = document.getElementById('username-display');
        if (usernameDisplay) {
            usernameDisplay.textContent = displayText;
            
            // Setup dropdown toggle
            usernameDisplay.addEventListener('click', toggleUserDropdown);
        }
        
        // Show admin link in dropdown if user is admin
        const adminDropdownLink = document.getElementById('admin-dropdown-link');
        if (adminDropdownLink && isAdmin) {
            adminDropdownLink.style.display = 'block';
        }
        
        // Show/hide management controls based on permissions
        updateUIPermissions();
        
        return true;
    } catch (error) {
        console.error('Auth check error:', error);
        window.location.href = '/login.html';
        return false;
    }
}

// Toggle user dropdown menu
function toggleUserDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('user-dropdown-menu');
    if (dropdown) {
        dropdown.classList.toggle('show');
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', (event) => {
    const dropdown = document.getElementById('user-dropdown-menu');
    const usernameBtn = document.getElementById('username-display');
    
    if (dropdown && !usernameBtn?.contains(event.target) && !dropdown.contains(event.target)) {
        dropdown.classList.remove('show');
    }

    // Close member overflow menus when clicking outside
    if (!event.target.closest('.member-overflow')) {
        document.querySelectorAll('.member-overflow.open').forEach(el => el.classList.remove('open'));
    }
});

// Update UI based on user permissions
function updateUIPermissions() {
    const actionBar = document.querySelector('.action-bar');
    
    if (!canManageRanks && actionBar) {
        // Hide the action bar for users without permission
        actionBar.style.display = 'none';
        
        // Add notice message
        const notice = document.createElement('div');
        notice.className = 'permission-notice';
        notice.innerHTML = '<p>ℹ️ Only R4 and R5 members can add or manage member ranks.</p>';
        document.querySelector('main').insertBefore(notice, document.querySelector('.members-section'));
    }
}

// Modal Functions
function openMemberModal(editing = false) {
    if (!canManageRanks) {
        showToast('You do not have permission to manage members. Only R4 and R5 can do this.', 'warning');
        return;
    }
    memberModal.style.display = 'flex';
    document.getElementById('member-name').focus();
}

function closeMemberModalFunc() {
    memberModal.style.display = 'none';
    resetMemberForm();
}

function resetMemberForm() {
    editingMemberId = null;
    document.getElementById('member-form').reset();
    document.getElementById('member-eligible').checked = true;
    document.getElementById('member-merit-eligible').checked = false;
    document.getElementById('member-nickname').value = '';
    document.getElementById('modal-form-title').textContent = 'Add New Member';
    document.getElementById('submit-btn').textContent = 'Add Member';
}

// Event Listeners for Modal
if (addMemberBtn) {
    addMemberBtn.addEventListener('click', () => openMemberModal(false));
}

if (closeMemberModal) {
    closeMemberModal.addEventListener('click', closeMemberModalFunc);
}

if (cancelBtn) {
    cancelBtn.addEventListener('click', closeMemberModalFunc);
}

if (importCsvTriggerBtn && csvImportSection) {
    importCsvTriggerBtn.addEventListener('click', () => {
        csvImportSection.style.display = 'block';
        csvImportSection.scrollIntoView({ behavior: 'smooth' });
    });
}

if (cancelImportBtn && csvImportSection) {
    cancelImportBtn.addEventListener('click', () => {
        csvImportSection.style.display = 'none';
        document.getElementById('csv-file').value = '';
        document.getElementById('import-result').style.display = 'none';
    });
}

// Close modal when clicking outside
window.addEventListener('click', (event) => {
    if (event.target === memberModal) {
        closeMemberModalFunc();
    }
});

// Load all members
async function loadMembers() {
    try {
        const response = await fetch(API_URL);
        const members = await response.json();
        allMembers = members; // Store for search
        displayMembers(members);
        updateMemberCount(members.length);
    } catch (error) {
        console.error('Error loading members:', error);
        document.getElementById('members-list').innerHTML = 
            '<p class="empty">🚨 Intel failure. Could not reach the survivors. Try again.</p>';
    }
}


// Display members in the list
function displayMembers(members) {
    const membersList = document.getElementById('members-list');
    
    if (!members || members.length === 0) {
        membersList.innerHTML = '<p class="empty">🏜️ No survivors on the roster. The wasteland claims them all. Add one to begin.</p>';
        return;
    }

    membersList.innerHTML = members.map(member => {
        const eligibleStatus = member.eligible !== false ? '✓ Eligible' : '✗ Not Eligible';
        const eligibleClass = member.eligible !== false ? 'eligible' : 'not-eligible';
        const meritStatus = isMeritEligible(member) ? '✓ Merit THP' : '✗ Not Merit';
        const meritClass = isMeritEligible(member) ? 'merit' : 'not-merit';
        
        // Format power display
        let powerDisplay = '';
        if (member.power) {
            powerDisplay = `<span class="member-power" title="${member.power.toLocaleString()}">${formatPower(member.power)}</span>`;
        }
        
        let actionsHtml = '';
        if (canManageRanks) {
            actionsHtml = `
                <div class="member-actions">
                    <button class="toggle-eligible-btn ${eligibleClass}" onclick="toggleEligible(${member.id}, ${member.eligible !== false})" title="${eligibleStatus}">${eligibleStatus}</button>
                    <button class="toggle-merit-btn ${meritClass}" onclick="toggleMerit(${member.id}, ${isMeritEligible(member)})" title="${meritStatus}">${meritStatus}</button>
                    <div class="member-overflow">
                        <button class="overflow-btn" onclick="this.parentElement.classList.toggle('open')" title="More actions">⋯</button>
                        <div class="overflow-menu">
                            <button class="overflow-item" onclick="editMember(${member.id})">✏️ Edit</button>
                            <button class="overflow-item overflow-danger" onclick="deleteMember(${member.id}, '${escapeHtml(member.name)}')">🗑️ Delete</button>
                            ${isR5OrAdmin ? `<button class="overflow-item" onclick="createUserForMember(${member.id}, '${escapeHtml(member.name)}')">👤 Create User</button>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }

        const nicknameHtml = member.nickname ? `<div class="member-nickname">aka ${escapeHtml(member.nickname)}</div>` : '';
        
        return `
            <div class="member-card">
                <div class="member-info">
                    <div class="member-name">${escapeHtml(member.name)}</div>
                    ${nicknameHtml}
                    <span class="member-rank rank-${member.rank.replace(/\s+/g, '-')}">${escapeHtml(member.rank)}</span>
                    ${powerDisplay}
                    <span class="member-eligible ${eligibleClass}">${eligibleStatus}</span>
                    <span class="member-merit ${meritClass}">${meritStatus}</span>
                </div>
                ${actionsHtml}
            </div>
        `;
    }).join('');
}
// Format power value with K/M/B suffixes
function formatPower(power) {
    if (!power) return '';
    
    if (power >= 1000000000) {
        return '⚡ ' + (power / 1000000000).toFixed(2) + 'B';
    } else if (power >= 1000000) {
        return '⚡ ' + (power / 1000000).toFixed(2) + 'M';
    } else if (power >= 1000) {
        return '⚡ ' + (power / 1000).toFixed(1) + 'K';
    } else {
        return '⚡ ' + power.toString();
    }
}

// Update member count
function updateMemberCount(count) {
    const heading = document.querySelector('.members-section h3');
    if (heading) {
        heading.textContent = `Alliance Members (${count})`;
    }
}

function isMeritEligible(member) {
    return member.merit_eligible === true || member.merit_eligible === 1 || member.merit_eligible === '1';
}

// Handle form submission
document.getElementById('member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!canManageRanks) {
        showToast('You do not have permission to manage members. Only R4 and R5 can do this.', 'warning');
        return;
    }
    
    const name = document.getElementById('member-name').value.trim();
    const nickname = document.getElementById('member-nickname').value.trim() || null;
    const rank = document.getElementById('member-rank').value;
    const eligible = document.getElementById('member-eligible').checked;
    const meritEligible = document.getElementById('member-merit-eligible').checked;
    
    // Inline validation
    let valid = true;
    const nameGroup = document.getElementById('member-name').closest('.form-group');
    const rankGroup = document.getElementById('member-rank').closest('.form-group');
    [nameGroup, rankGroup].forEach(g => g && g.classList.remove('has-error'));
    if (!name) { nameGroup && nameGroup.classList.add('has-error'); valid = false; }
    if (!rank) { rankGroup && rankGroup.classList.add('has-error'); valid = false; }
    if (!valid) return;

    const submitBtn = document.getElementById('submit-btn');
    setButtonLoading(submitBtn, 'Saving...');
    try {
        if (editingMemberId) {
            // Update existing member
            const response = await fetch(`${API_URL}/${editingMemberId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name, nickname, rank, eligible, merit_eligible: meritEligible }),
            });

            if (!response.ok) throw new Error('Failed to update member');

            const savedMember = await response.json();
            if (isMeritEligible(savedMember) !== meritEligible) {
                throw new Error('The server did not save the Merit THP setting');
            }
            
            editingMemberId = null;
        } else {
            // Add new member
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name, nickname, rank, eligible, merit_eligible: meritEligible }),
            });

            if (!response.ok) {
                if (response.status === 403) {
                    throw new Error('Permission denied: Only R4/R5 members can manage ranks');
                }
                throw new Error('Failed to add member');
            }
        }

        // Close modal, reset form and reload members
        closeMemberModalFunc();
        await loadMembers();
    } catch (error) {
        console.error('Error saving member:', error);
        showToast('Failed to save member. Please try again.', 'error');
    } finally {
        clearButtonLoading(submitBtn);
    }
});

// Edit a member
function editMember(id) {
    if (!canManageRanks) {
        showToast('You do not have permission to edit members. Only R4 and R5 can do this.', 'warning');
        return;
    }
    
    const member = allMembers.find(m => m.id === id);
    if (!member) return;

    editingMemberId = id;
    document.getElementById('member-name').value = member.name;
    document.getElementById('member-nickname').value = member.nickname || '';
    document.getElementById('member-rank').value = member.rank;
    document.getElementById('member-eligible').checked = member.eligible !== false;
    document.getElementById('member-merit-eligible').checked = isMeritEligible(member);
    document.getElementById('modal-form-title').textContent = 'Edit Member';
    document.getElementById('submit-btn').textContent = 'Update Member';
    
    // Open modal
    openMemberModal(true);
}

// Delete a member
async function deleteMember(id, name) {
    if (!canManageRanks) {
        showToast('You do not have permission to delete members. Only R4 and R5 can do this.', 'warning');
        return;
    }
    
    const confirmed = await showConfirm(
        `Remove ${name} from the alliance? This action cannot be undone.`,
        'Remove Member',
        'Remove',
        'Cancel',
        true
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_URL}/${id}`, {
            method: 'DELETE',
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error('Permission denied: Only R4/R5 members can manage members');
            }
            throw new Error('Failed to delete member');
        }
        
        await loadMembers();
    } catch (error) {
        console.error('Error deleting member:', error);
        showToast('Failed to delete member. Please try again.', 'error');
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Logout handler
async function handleLogout() {
    try {
        const response = await fetch('/api/logout', {
            method: 'POST'
        });
        
        if (response.ok) {
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/login.html';
    }
}

// Load members when page loads
document.addEventListener('DOMContentLoaded', async () => {
    const isAuthenticated = await checkAuth();
    if (isAuthenticated) {
        loadMembers();
        setupCSVImport();
        setupSearch();
        setupLogoutButtons();
    }
});

// Setup logout buttons
function setupLogoutButtons() {
    // Old logout button (if exists)
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // Dropdown logout button
    const dropdownLogoutBtn = document.getElementById('dropdown-logout-btn');
    if (dropdownLogoutBtn) {
        dropdownLogoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleLogout();
        });
    }
}

// Setup search functionality
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    
    if (!searchInput) return;
    
    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        
        if (searchTerm) {
            clearBtn.style.display = 'flex';
            const filtered = allMembers.filter(member => 
                member.name.toLowerCase().includes(searchTerm) ||
                member.rank.toLowerCase().includes(searchTerm)
            );
            displayMembers(filtered);
            updateMemberCount(filtered.length);
        } else {
            clearBtn.style.display = 'none';
            displayMembers(allMembers);
            updateMemberCount(allMembers.length);
        }
    });
    
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        displayMembers(allMembers);
        updateMemberCount(allMembers.length);
        searchInput.focus();
    });
}

// Setup CSV import functionality
let detectedCSVMembers = [];
let selectedCSVMembers = new Set();
let membersToRemove = [];
let selectedRemoveMembers = new Set();

function setupCSVImport() {
    const importBtn = document.getElementById('import-btn');
    const fileInput = document.getElementById('csv-file');
    const modal = document.getElementById('csv-preview-modal');
    const closeModal = document.getElementById('close-csv-modal');
    const confirmBtn = document.getElementById('confirm-csv-btn');
    const cancelBtn = document.getElementById('cancel-csv-btn');
    
    if (!importBtn || !fileInput) return;
    
    // Preview CSV button
    importBtn.addEventListener('click', async () => {
        if (!canManageRanks) {
            showToast('You do not have permission to import members. Only R4 and R5 can do this.', 'warning');
            return;
        }
        
        const file = fileInput.files[0];
        if (!file) {
            showToast('Please select a CSV file to import', 'warning');
            return;
        }
        
        if (!file.name.endsWith('.csv')) {
            showToast('Please select a valid CSV file', 'warning');
            return;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        
        importBtn.disabled = true;
        importBtn.textContent = 'Loading...';
        
        try {
            const response = await fetch('/api/members/import', {
                method: 'POST',
                body: formData,
            });
            
            if (!response.ok) {
                if (response.status === 403) {
                    throw new Error('Permission denied: Only R4/R5 members can import members');
                }
                const errorText = await response.text();
                throw new Error(errorText || 'Failed to read CSV');
            }
            
            const result = await response.json();
            
            if (result.errors && result.errors.length > 0) {
                displayImportError('CSV contains errors:\n' + result.errors.join('\n'));
            }
            
            if (result.detected_members && result.detected_members.length > 0) {
                detectedCSVMembers = result.detected_members;
                selectedCSVMembers = new Set(result.detected_members.map((m, i) => i)); // Select all by default
                membersToRemove = result.members_to_remove || [];
                selectedRemoveMembers = new Set(); // Don't select any for removal by default
                showCSVPreview(result);
                modal.style.display = 'flex';
            } else {
                displayImportError('No valid members found in CSV file');
            }
            
        } catch (error) {
            console.error('Import error:', error);
            displayImportError(error.message);
        } finally {
            importBtn.disabled = false;
            importBtn.textContent = 'Preview CSV';
        }
    });
    
    // Close modal
    closeModal.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    cancelBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    // Confirm import
    confirmBtn.addEventListener('click', async () => {
        const selectedMembers = detectedCSVMembers.filter((_, i) => selectedCSVMembers.has(i));
        
        if (selectedMembers.length === 0) {
            showToast('Please select at least one member to import', 'warning');
            return;
        }
        
        // Collect renames from dropdown selections
        const renames = [];
        const renameSelects = document.querySelectorAll('.rename-select');
        renameSelects.forEach(select => {
            const oldName = select.value;
            if (oldName) { // If a rename option was selected
                const newName = select.dataset.newName;
                renames.push({ old_name: oldName, new_name: newName });
            }
        });
        
        // Collect selected member IDs to remove
        const removeMemberIDs = Array.from(selectedRemoveMembers);
        
        if (removeMemberIDs.length > 0) {
            const memberNames = removeMemberIDs.map(id => {
                const member = membersToRemove.find(m => m.id === id);
                return member ? member.name : 'Unknown';
            }).join(', ');
            const confirmed = await showConfirm(
                `You are about to delete ${removeMemberIDs.length} member(s): ${memberNames}. This cannot be undone.`,
                '⚠️ Delete Members',
                'Delete',
                'Cancel',
                true
            );
            if (!confirmed) return;
        }
        
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Importing...';
        
        try {
            const response = await fetch('/api/members/import/confirm', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    members: selectedMembers,
                    remove_member_ids: removeMemberIDs,
                    renames: renames
                })
            });
            
            if (!response.ok) {
                throw new Error('Failed to import members');
            }
            
            const result = await response.json();
            modal.style.display = 'none';
            
            let message = `✓ Successfully imported ${result.added + result.updated} member(s)`;
            if (result.removed > 0) {
                message += `\n🗑️ Removed ${result.removed} member(s) not in CSV`;
            }
            if (result.unchanged > 0) {
                message += `\n→ ${result.unchanged} unchanged`;
            }
            
            displayImportResult({
                imported: result.added + result.updated,
                skipped: result.unchanged,
                removed: result.removed,
                errors: []
            });
            
            // Reload members list
            await loadMembers();
            
            // Clear file input
            fileInput.value = '';
            
        } catch (error) {
            console.error('Confirm error:', error);
            showToast('Error importing members: ' + error.message, 'error');
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '✔ Confirm & Import Selected';
        }
    });
}

// Show CSV preview in modal
function showCSVPreview(result) {
    const summaryDiv = document.getElementById('csv-summary');
    const previewDiv = document.getElementById('csv-members-preview');
    
    const newCount = result.detected_members.filter(m => m.is_new).length;
    const changedCount = result.detected_members.filter(m => m.rank_changed).length;
    const unchangedCount = result.detected_members.length - newCount - changedCount;
    const similarCount = result.detected_members.filter(m => m.similar_match && m.similar_match.length > 0).length;
    
    summaryDiv.innerHTML = `
        <div class="summary-stats">
            <div class="stat-item">
                <span class="stat-label">Total Members:</span>
                <span class="stat-value">${result.detected_members.length}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label new">New Members:</span>
                <span class="stat-value new">${newCount}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label change">Rank Changes:</span>
                <span class="stat-value change">${changedCount}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">No Changes:</span>
                <span class="stat-value">${unchangedCount}</span>
            </div>
            ${similarCount > 0 ? `
            <div class="stat-item">
                <span class="stat-label warning">Similar Names:</span>
                <span class="stat-value warning">${similarCount}</span>
            </div>
            ` : ''}
        </div>
    `;
    
    let html = '<div class="csv-members-list">';
    result.detected_members.forEach((member, index) => {
        const statusClass = member.is_new ? 'new' : (member.rank_changed ? 'changed' : 'unchanged');
        const statusText = member.is_new ? 'NEW' : (member.rank_changed ? `${member.old_rank} → ${member.rank}` : 'No Change');
        const checked = selectedCSVMembers.has(index) ? 'checked' : '';
        
        html += `
            <div class="csv-member-item ${statusClass}">
                <input type="checkbox" class="member-checkbox" data-index="${index}" ${checked}>
                <div class="member-info">
                    <span class="member-name">${escapeHtml(member.name)}</span>
                    <span class="member-rank rank-${member.rank}">${member.rank}</span>
                    <span class="member-status">${statusText}</span>
                </div>
                ${member.similar_match && member.similar_match.length > 0 ? `
                    <div class="similar-match-notice">
                        <span class="warning-icon">⚠️</span>
                        <span>Similar name(s) found: ${member.similar_match.map(n => escapeHtml(n)).join(', ')}</span>
                        <select class="rename-select" data-index="${index}" data-new-name="${escapeHtml(member.name)}">
                            <option value="">Add as new member</option>
                            ${member.similar_match.map(oldName => 
                                `<option value="${escapeHtml(oldName)}">Rename "${escapeHtml(oldName)}" to "${escapeHtml(member.name)}"</option>`
                            ).join('')}
                        </select>
                    </div>
                ` : ''}
            </div>
        `;
    });
    html += '</div>';
    
    previewDiv.innerHTML = html;
    
    // Add checkbox event listeners
    previewDiv.querySelectorAll('.member-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const index = parseInt(e.target.dataset.index);
            if (e.target.checked) {
                selectedCSVMembers.add(index);
            } else {
                selectedCSVMembers.delete(index);
            }
        });
    });
    
    // Show members to remove section if there are any
    const removeSection = document.getElementById('remove-members-section');
    const removeList = document.getElementById('members-to-remove-list');
    
    if (membersToRemove && membersToRemove.length > 0) {
        removeSection.style.display = 'block';
        
        let removeHtml = '<div class="members-to-remove-grid">';
        membersToRemove.forEach(member => {
            removeHtml += `
                <div class="remove-member-item">
                    <input type="checkbox" class="remove-checkbox" data-member-id="${member.id}">
                    <div class="remove-member-info">
                        <span class="remove-member-name">${escapeHtml(member.name)}</span>
                        <span class="member-rank rank-${member.rank}">${member.rank}</span>
                    </div>
                </div>
            `;
        });
        removeHtml += '</div>';
        
        removeList.innerHTML = removeHtml;
        
        // Add checkbox event listeners for remove members
        removeList.querySelectorAll('.remove-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const memberId = parseInt(e.target.dataset.memberId);
                if (e.target.checked) {
                    selectedRemoveMembers.add(memberId);
                } else {
                    selectedRemoveMembers.delete(memberId);
                }
            });
        });
    } else {
        removeSection.style.display = 'none';
    }
}

// Display import results
function displayImportResult(result) {
    const resultDiv = document.getElementById('import-result');
    resultDiv.style.display = 'block';
    
    let className = 'success';
    let message = '';
    
    if (result.imported > 0 && result.skipped === 0) {
        className = 'success';
        message = `✓ Successfully imported ${result.imported} member${result.imported > 1 ? 's' : ''}!`;
    } else if (result.imported > 0 && result.skipped > 0) {
        className = 'warning';
        message = `⚠ Imported ${result.imported} member${result.imported > 1 ? 's' : ''}, skipped ${result.skipped} row${result.skipped > 1 ? 's' : ''}.`;
    } else if (result.imported === 0 && result.skipped > 0) {
        className = 'error';
        message = `✗ No members imported. ${result.skipped} row${result.skipped > 1 ? 's' : ''} skipped.`;
    }
    
    resultDiv.className = `import-result ${className}`;
    
    let html = `<strong>${message}</strong>`;
    
    if (result.errors && result.errors.length > 0) {
        html += '<ul>';
        result.errors.forEach(error => {
            html += `<li>${escapeHtml(error)}</li>`;
        });
        html += '</ul>';
    }
    
    resultDiv.innerHTML = html;
    
    // Auto-hide after 10 seconds if no errors
    if (result.errors.length === 0) {
        setTimeout(() => {
            resultDiv.style.display = 'none';
        }, 10000);
    }
}

// Display import error
function displayImportError(message) {
    const resultDiv = document.getElementById('import-result');
    resultDiv.style.display = 'block';
    resultDiv.className = 'import-result error';
    resultDiv.innerHTML = `<strong>✗ Import failed:</strong> ${escapeHtml(message)}`;
}

// Create user for member
async function createUserForMember(memberId, memberName) {
    const confirmed = await showConfirm(`Create a user account for ${memberName}? A random password will be generated.`, 'Create User Account', 'Create');
    if (!confirmed) return;
    
    try {
        const response = await fetch(`${API_URL}/${memberId}/create-user`, {
            method: 'POST'
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(error);
        }
        
        const result = await response.json();
        
        // Display the username and password in a toast + console
        showToast(`User created! Username: ${result.username} — Password: ${result.password} (saved to console)`, 'success', 8000);
        console.log('=== NEW USER CREDENTIALS ===');
        console.log('Username:', result.username);
        console.log('Password:', result.password);
        console.log('============================');
        
    } catch (error) {
        console.error('Error creating user:', error);
        showToast('Failed to create user: ' + error.message, 'error');
    }
}

// Toggle member eligibility for train
async function toggleEligible(id, currentStatus) {
    if (!canManageRanks) {
        showToast('You do not have permission to manage members. Only R4 and R5 can do this.', 'warning');
        return;
    }
    
    const newStatus = !currentStatus;
    const statusText = newStatus ? 'eligible' : 'not eligible';
    
    const confirmed = await showConfirm(
        `Mark this member as ${statusText} for train scheduling?`,
        'Update Eligibility',
        'Confirm',
        'Cancel',
        false
    );
    if (!confirmed) return;
    
    try {
        // Get current member data
        const response = await fetch(`${API_URL}`);
        if (!response.ok) throw new Error('Failed to fetch members');
        
        const members = await response.json();
        const member = members.find(m => m.id === id);
        
        if (!member) throw new Error('Member not found');
        
        // Update member with new eligible status
        const updateResponse = await fetch(`${API_URL}/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                name: member.name, 
                rank: member.rank,
                eligible: newStatus 
            }),
        });
        
        if (!updateResponse.ok) throw new Error('Failed to update member');
        
        // Reload members list
        loadMembers();
    } catch (error) {
        console.error('Error toggling eligibility:', error);
        showToast('Failed to update member eligibility: ' + error.message, 'error');
    }
}

// Toggle merit pool membership for THP
async function toggleMerit(id, currentStatus) {
    if (!canManageRanks) {
        showToast('You do not have permission to manage members. Only R4 and R5 can do this.', 'warning');
        return;
    }

    const newStatus = !currentStatus;
    const statusText = newStatus ? 'included in' : 'removed from';

    const confirmed = await showConfirm(
        `Mark this member as ${statusText} the THP merit pool?`,
        'Update Merit Pool',
        'Confirm',
        'Cancel',
        false
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_URL}`);
        if (!response.ok) throw new Error('Failed to fetch members');

        const members = await response.json();
        const member = members.find(m => m.id === id);

        if (!member) throw new Error('Member not found');

        const updateResponse = await fetch(`${API_URL}/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: member.name,
                rank: member.rank,
                merit_eligible: newStatus
            }),
        });

        if (!updateResponse.ok) throw new Error('Failed to update member');

        loadMembers();
    } catch (error) {
        console.error('Error toggling merit pool:', error);
        showToast('Failed to update merit pool membership: ' + error.message, 'error');
    }
}
