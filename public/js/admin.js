// HTML转义函数 - 防止XSS攻击
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// 全局状态：记住当前正在查看的用户信息
let currentViewingUser = null;

// 分页状态
let currentPage = 1;
let pageSize = 20;
let totalUsers = 0;

// 邮箱列表分页状态
let currentMailboxPage = 1;
let mailboxPageSize = 20;
let totalMailboxes = 0;

// 导航控制变量
let isNavigating = false;
let lastNavigateTime = 0;
let navigationTimer = null;

const els = {
  back: document.getElementById('back'),
  logout: document.getElementById('logout'),
  demoBanner: document.getElementById('demo-banner'),
  usersTbody: document.getElementById('users-tbody'),
  usersRefresh: document.getElementById('users-refresh'),
  usersLoading: document.getElementById('users-loading'),
  usersCount: document.getElementById('users-count'),
  usersPagination: document.getElementById('users-pagination'),
  paginationText: document.getElementById('pagination-text'),
  pageInfo: document.getElementById('page-info'),
  prevPage: document.getElementById('prev-page'),
  nextPage: document.getElementById('next-page'),
  toast: document.getElementById('toast'),
  telegramStatusBadge: document.getElementById('telegram-status-badge'),
  telegramStatusRefresh: document.getElementById('telegram-status-refresh'),
  telegramStatusLoading: document.getElementById('telegram-status-loading'),
  telegramStatusContent: document.getElementById('telegram-status-content'),
  telegramTest: document.getElementById('telegram-test'),
  telegramConnect: document.getElementById('telegram-connect'),
  tgBotName: document.getElementById('tg-bot-name'),
  tgBotId: document.getElementById('tg-bot-id'),
  tgBotUsername: document.getElementById('tg-bot-username'),
  tgChatId: document.getElementById('tg-chat-id'),
  tgToken: document.getElementById('tg-token'),
  tgWebhook: document.getElementById('tg-webhook'),
  tgExtra: document.getElementById('tg-extra'),
  domainUsageBody: document.getElementById('domain-usage-body'),
  forwardConfigInput: document.getElementById('forward-config-input'),
  forwardConfigSave: document.getElementById('forward-config-save'),
  forwardConfigMsg: document.getElementById('forward-config-msg'),
  
  // 检查必要的DOM元素是否存在
  checkRequiredElements() {
    const required = ['usersTbody', 'usersRefresh', 'usersLoading', 'usersCount'];
    const missing = required.filter(key => !this[key]);
    if (missing.length > 0) {
      console.error('管理页面缺少必要的DOM元素:', missing);
      return false;
    }
    return true;
  },
  // modals
  uOpen: document.getElementById('u-open'),
  uModal: document.getElementById('u-modal'),
  uClose: document.getElementById('u-close'),
  uCancel: document.getElementById('u-cancel'),
  uCreate: document.getElementById('u-create'),
  uName: document.getElementById('u-name'),
  uPass: document.getElementById('u-pass'),
  uRole: document.getElementById('u-role'),

  aOpen: document.getElementById('a-open'),
  aModal: document.getElementById('a-modal'),
  aClose: document.getElementById('a-close'),
  aCancel: document.getElementById('a-cancel'),
  aAssign: document.getElementById('a-assign'),
  aName: document.getElementById('a-name'),
  aMail: document.getElementById('a-mail'),

  unassignOpen: document.getElementById('unassign-open'),
  unassignModal: document.getElementById('unassign-modal'),
  unassignClose: document.getElementById('unassign-close'),
  unassignCancel: document.getElementById('unassign-cancel'),
  unassignSubmit: document.getElementById('unassign-submit'),
  unassignName: document.getElementById('unassign-name'),
  unassignMail: document.getElementById('unassign-mail'),

  userMailboxes: document.getElementById('user-mailboxes'),
  userMailboxesLoading: document.getElementById('user-mailboxes-loading'),
  mailboxesCount: document.getElementById('mailboxes-count'),
  mailboxesRefresh: document.getElementById('mailboxes-refresh'),
  mailboxesPagination: document.getElementById('mailboxes-pagination'),
  mailboxesPaginationText: document.getElementById('mailboxes-pagination-text'),
  mailboxesPageInfo: document.getElementById('mailboxes-page-info'),
  mailboxesPrevPage: document.getElementById('mailboxes-prev-page'),
  mailboxesNextPage: document.getElementById('mailboxes-next-page'),
  // edit modal
  editModal: document.getElementById('edit-modal'),
  editClose: document.getElementById('edit-close'),
  editCancel: document.getElementById('edit-cancel'),
  editSave: document.getElementById('edit-save'),
  editRefresh: document.getElementById('edit-refresh'),
  editName: document.getElementById('edit-name'),
  editUserDisplay: document.getElementById('edit-user-display'),
  editNewName: document.getElementById('edit-new-name'),
  editRoleCheck: document.getElementById('edit-role-check'),
  editLimit: document.getElementById('edit-limit'),
  editSendCheck: document.getElementById('edit-send-check'),
  editPass: document.getElementById('edit-pass'),
  editDelete: document.getElementById('edit-delete'),
  adminConfirmModal: document.getElementById('admin-confirm-modal'),
  adminConfirmClose: document.getElementById('admin-confirm-close'),
  adminConfirmCancel: document.getElementById('admin-confirm-cancel'),
  adminConfirmOk: document.getElementById('admin-confirm-ok'),
  adminConfirmMessage: document.getElementById('admin-confirm-message')
};

function formatTs(ts){
  if (!ts) return '';
  try{
    const iso = ts.includes('T') ? ts.replace(' ', 'T') : ts.replace(' ', 'T');
    const d = new Date(iso + 'Z');
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(d);
  }catch(_){ return ts; }
}

// showToast 函数已由 toast-utils.js 统一提供

// 公用复制
window.copyText = async (text, btn) => {
  try{ 
    await navigator.clipboard.writeText(String(text||'')); 
    showToast('已复制到剪贴板','success'); 
    
    // 如果传递了按钮元素，改变其图标提供反馈
    if (btn && btn.querySelector) {
      const span = btn.querySelector('span');
      if (span) {
        const originalText = span.textContent;
        span.textContent = '✅';
        setTimeout(() => {
          span.textContent = originalText;
        }, 1500);
      }
    }
  }
  catch(_){ showToast('复制失败','warn'); }
};

// 当前确认对话框的控制器，避免快速连续操作时的冲突
let currentAdminConfirmController = null;

function openAdminConfirm(message, onOk){
  try{
    // 如果有之前的控制器，先取消并清理状态
    if (currentAdminConfirmController) {
      currentAdminConfirmController.abort();
      // 强制重置任何可能残留的操作状态
      if (els.adminConfirmModal._isProcessing) {
        isUnassigning = false;
        isAssigning = false;
        isCreatingUser = false;
        isEditingUser = false;
        els.adminConfirmModal._isProcessing = false;
      }
    }
    
    // 创建新的 AbortController
    currentAdminConfirmController = new AbortController();
    const signal = currentAdminConfirmController.signal;
    
    // 将回调保存到模态框的属性中，避免闭包变量污染
    // 使用时间戳确保每次调用的唯一性
    const confirmId = Date.now() + Math.random();
    els.adminConfirmModal._currentOnOk = onOk;
    els.adminConfirmModal._confirmId = confirmId;
    els.adminConfirmModal._isProcessing = false;
    
    els.adminConfirmMessage.textContent = message || '确认执行该操作？';
    els.adminConfirmModal.classList.add('show');
    
    const closeIt = () => { 
      els.adminConfirmModal.classList.remove('show');
      currentAdminConfirmController = null;
      delete els.adminConfirmModal._currentOnOk;
      delete els.adminConfirmModal._confirmId;
      delete els.adminConfirmModal._isProcessing;
    };
    
    // 使用 AbortController 管理事件监听器，避免重复绑定
    const onCancel = () => closeIt();
    const onConfirm = async () => {
      // 检查是否正在处理或者确认ID已改变（被新的确认覆盖）
      if (els.adminConfirmModal._isProcessing || 
          els.adminConfirmModal._confirmId !== confirmId) {
        return;
      }
      
      try{ 
        els.adminConfirmModal._isProcessing = true;
        setButtonLoading(els.adminConfirmOk, '处理中…');
        // 从模态框属性中获取回调，避免闭包变量问题
        const currentOnOk = els.adminConfirmModal._currentOnOk;
        // 再次检查确认ID，确保没有被覆盖
        if (els.adminConfirmModal._confirmId === confirmId && currentOnOk) {
          await currentOnOk(); 
        }
      } finally { 
        try{ restoreButton(els.adminConfirmOk); }catch(_){ }
        closeIt(); 
      } 
    };
    
    els.adminConfirmCancel.addEventListener('click', onCancel, { signal });
    els.adminConfirmClose.addEventListener('click', onCancel, { signal });
    els.adminConfirmOk.addEventListener('click', onConfirm, { signal });
    
  }catch(err){ 
    console.error('确认对话框初始化失败:', err);
    if (confirm(message||'确认执行该操作？')) onOk?.(); 
  }
}

async function api(path, options){
  const r = await fetch(path, options);
  if (r.status === 401){ 
    location.replace('/html/login.html'); 
    throw new Error('unauthorized'); 
  }
  if (!r.ok) {
    const errorText = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(errorText || `HTTP ${r.status} ${r.statusText}`);
  }
  return r;
}

function openModal(m){ m?.classList?.add('show'); }
function closeModal(m){ m?.classList?.remove('show'); }

async function loadUsers(page = currentPage){
  try{
    if (els.usersLoading){ els.usersLoading.style.display = 'inline-flex'; }
    
    // 计算偏移量
    const offset = (page - 1) * pageSize;
    const r = await api(`/api/users?limit=${pageSize}&offset=${offset}&sort=asc`);
    const users = await r.json();
    
    currentPage = page;
    
    // 首次加载时获取总用户数（不分页）
    if (page === 1) {
      try {
        // 获取所有用户来计算总数
        const totalR = await api(`/api/users?limit=1000&offset=0&sort=asc`);
        const totalUsersData = await totalR.json();
        totalUsers = totalUsersData.length;
      } catch (e) {
        // 估算总数
        if (users.length < pageSize) {
          totalUsers = offset + users.length;
        } else {
          totalUsers = Math.max(totalUsers, offset + pageSize);
        }
      }
    } else {
      // 非首页不重新计算总数
      if (users.length < pageSize && offset + users.length < totalUsers) {
        totalUsers = offset + users.length;
      }
    }
    els.usersTbody.innerHTML = (users||[]).map(u => {
      const roleClass = u.role === 'admin' ? 'role-admin' : 'role-user';
      const roleText = u.role === 'admin' ? '高级' : '普通';
      const canSendClass = u.can_send ? 'can-send-yes' : 'can-send-no';
      const canSendText = u.can_send ? '是' : '否';
      
      // 用户名缩写处理 - 如果超过6个字符则缩写
      const username = u.username || '';
      const displayUsername = username.length > 6 ? username.substring(0, 5) + '…' : username;
      
      // 转义用户名防止XSS
      const safeUsername = escapeHtml(username);
      const safeDisplayUsername = escapeHtml(displayUsername);
      
      return `
      <tr data-user-id="${u.id}">
        <td class="col-id">${u.id}</td>
        <td class="col-username" title="${safeUsername}">${safeDisplayUsername}</td>
        <td class="col-role"><span class="${roleClass}">${roleText}</span></td>
        <td class="col-mailbox">${u.mailbox_count || 0} / <span class="badge">${u.mailbox_limit}</span></td>
        <td class="col-can ${canSendClass}">${canSendText}</td>
        <td class="col-created">${formatTs(u.created_at)}</td>
        <td class="col-actions">
          <div class="user-actions">
            <button class="btn btn-ghost btn-sm" onclick="viewUserMailboxes(this, ${u.id}, '${safeUsername}')" title="查看用户邮箱">邮箱</button>
            <button class="btn btn-secondary btn-sm" onclick="openEdit(${u.id}, '${safeUsername}', '${u.role}', ${u.mailbox_limit}, ${u.can_send?1:0})" title="编辑用户">编辑</button>
          </div>
        </td>
      </tr>
    `;
    }).join('');
    
    // 更新分页UI和用户数量显示
    updatePaginationUI();
    updateUsersCountDisplay();
    
  }catch(e){ 
    els.usersTbody.innerHTML = '<tr><td colspan="6" style="color:#dc2626">加载失败</td></tr>';
  }
  finally { if (els.usersLoading){ els.usersLoading.style.display = 'none'; } }
}

window.viewUserMailboxes = async (a, b, c) => {
  let btn = null, userId = a, username = b;
  if (a && typeof a === 'object' && a.tagName){ btn = a; userId = b; username = c; }
  
  // 确保userId是有效的数字
  const numericUserId = Number(userId);
  if (!userId || isNaN(numericUserId) || numericUserId <= 0) {
    showToast('无效的用户ID，请重试', 'warn');
    return;
  }
  
  // 记住当前查看的用户信息并重置分页
  currentViewingUser = { userId: numericUserId, username: username };
  currentMailboxPage = 1;
  
  // 高亮当前选中的用户行
  highlightUserRow(numericUserId);
  
  // 显示刷新按钮
  if (els.mailboxesRefresh) els.mailboxesRefresh.style.display = 'flex';
  
  // 加载第一页
  await loadUserMailboxes(numericUserId, username, currentMailboxPage, btn);
}

// 加载用户邮箱列表（支持分页）
async function loadUserMailboxes(userId, username, page = currentMailboxPage, btn = null) {
  try{
    if (btn) setButtonLoading(btn, '加载中…');
    // 显示加载指示器
    if (els.userMailboxesLoading){ 
      els.userMailboxesLoading.style.display = 'inline-flex'; 
    }
    
    const r = await api(`/api/users/${userId}/mailboxes`);
    const allMailboxes = await r.json();
    
    // 更新总数
    totalMailboxes = (allMailboxes || []).length;
    currentMailboxPage = page;
    
    // 计算分页
    const startIndex = (page - 1) * mailboxPageSize;
    const endIndex = startIndex + mailboxPageSize;
    const paginatedMailboxes = (allMailboxes || []).slice(startIndex, endIndex);
    
    // 更新邮箱数量显示
    updateMailboxesCountDisplay();
    
    // 渲染邮箱列表 - 转义邮箱地址防止XSS
    els.userMailboxes.innerHTML = `<div class="user-mailboxes">` +
      paginatedMailboxes.map(x => {
        const safeAddress = escapeHtml(x.address);
        return `
        <div class="user-mailbox-item" onclick="selectMailboxAndGoToHomepage('${safeAddress}', event)" style="cursor: pointer;" title="点击跳转到该邮箱">
          <div class="mailbox-content">
            <span class="addr" title="${safeAddress}">${safeAddress}</span>
            <span class="time">${formatTs(x.created_at)}</span>
          </div>
          <div class="mailbox-actions" onclick="event.stopPropagation();">
            <button class="btn btn-ghost btn-sm" onclick="copyText('${safeAddress}', this)" title="复制邮箱地址">
              <span>📋</span>
            </button>
            <button class="btn btn-danger btn-sm" onclick="unassignSingleMailbox('${escapeHtml(username)}', '${safeAddress}')" title="取消分配">
              <span>🗑️</span>
            </button>
          </div>
        </div>`;
      }).join('') + `</div>`;
    
    // 更新分页UI
    updateMailboxesPaginationUI();
      
  }catch(e){ 
    let errorMsg = '加载用户邮箱失败';
    const safeMessage = escapeHtml(e.message || '未知错误');
    if (e.message) {
      errorMsg += ': ' + safeMessage;
    }
    showToast(errorMsg,'warn'); 
    els.userMailboxes.innerHTML = `<div style="color:#dc2626;padding:12px">加载失败: ${safeMessage}</div>`;
    // 隐藏分页和数量显示
    if (els.mailboxesPagination) els.mailboxesPagination.style.display = 'none';
    if (els.mailboxesCount) els.mailboxesCount.textContent = '（0 邮箱）';
  }
  finally { 
    // 确保隐藏加载指示器
    if (els.userMailboxesLoading){ 
      els.userMailboxesLoading.style.display = 'none'; 
    }
    if (btn) restoreButton(btn);
  }
}

// 高亮选中的用户行
function highlightUserRow(userId) {
  // 移除所有现有的高亮
  const allRows = document.querySelectorAll('#users-tbody tr');
  allRows.forEach(row => row.classList.remove('active'));
  
  // 高亮指定用户的行（通过data-user-id属性）
  if (userId) {
    const targetRow = document.querySelector(`#users-tbody tr[data-user-id="${userId}"]`);
    if (targetRow) {
      targetRow.classList.add('active');
    }
  }
}

// 重新加载当前查看用户的邮箱列表
async function reloadCurrentUserMailboxes() {
  if (currentViewingUser && currentViewingUser.userId && currentViewingUser.username) {
    try {
      // 确保userId是有效的数字
      const numericUserId = Number(currentViewingUser.userId);
      if (isNaN(numericUserId) || numericUserId <= 0) {
        currentViewingUser = null;
        els.userMailboxes.innerHTML = '<div style="color:#dc2626;padding:12px">用户ID无效，请重新选择用户</div>';
        return;
      }
      
      await loadUserMailboxes(numericUserId, currentViewingUser.username, currentMailboxPage);
    } catch (e) {
      const safeMessage = escapeHtml(e.message || '未知错误');
      els.userMailboxes.innerHTML = `<div style="color:#dc2626;padding:12px">重新加载失败: ${safeMessage}</div>`;
    }
  } else {
    // 清除高亮并隐藏邮箱相关UI
    highlightUserRow(null);
    if (els.mailboxesRefresh) els.mailboxesRefresh.style.display = 'none';
    if (els.mailboxesPagination) els.mailboxesPagination.style.display = 'none';
    if (els.mailboxesCount) els.mailboxesCount.textContent = '（0 邮箱）';
  }
}

// 更新分页UI
function updatePaginationUI() {
  if (!els.usersPagination) return;
  
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const startIndex = (currentPage - 1) * pageSize + 1;
  const endIndex = Math.min(currentPage * pageSize, totalUsers);
  
  // 显示/隐藏分页控件
  if (totalUsers > pageSize || currentPage > 1) {
    els.usersPagination.style.display = 'flex';
  } else {
    els.usersPagination.style.display = 'none';
    return;
  }
  
  // 更新分页信息文本
  if (els.paginationText) {
    els.paginationText.textContent = `显示 ${startIndex}-${endIndex} 条，共 ${totalUsers} 条`;
  }
  
  // 更新页码信息
  if (els.pageInfo) {
    els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  }
  
  // 更新按钮状态
  if (els.prevPage) {
    els.prevPage.disabled = currentPage <= 1;
  }
  if (els.nextPage) {
    els.nextPage.disabled = currentPage >= totalPages;
  }
}

// 更新用户数量显示
function updateUsersCountDisplay() {
  if (els.usersCount) {
    els.usersCount.textContent = `（${totalUsers} 用户）`;
  }
}

// 更新邮箱数量显示
function updateMailboxesCountDisplay() {
  if (els.mailboxesCount) {
    els.mailboxesCount.textContent = `（${totalMailboxes} 邮箱）`;
  }
}

// 更新邮箱分页UI
function updateMailboxesPaginationUI() {
  if (!els.mailboxesPagination) return;
  
  const totalPages = Math.max(1, Math.ceil(totalMailboxes / mailboxPageSize));
  const startIndex = (currentMailboxPage - 1) * mailboxPageSize + 1;
  const endIndex = Math.min(currentMailboxPage * mailboxPageSize, totalMailboxes);
  
  // 显示/隐藏分页控件
  if (totalMailboxes > mailboxPageSize || currentMailboxPage > 1) {
    els.mailboxesPagination.style.display = 'flex';
  } else {
    els.mailboxesPagination.style.display = 'none';
    return;
  }
  
  // 更新分页信息文本
  if (els.mailboxesPaginationText) {
    els.mailboxesPaginationText.textContent = `显示 ${startIndex}-${endIndex} 条，共 ${totalMailboxes} 条`;
  }
  
  // 更新页码信息
  if (els.mailboxesPageInfo) {
    els.mailboxesPageInfo.textContent = `${currentMailboxPage} / ${totalPages}`;
  }
  
  // 更新按钮状态
  if (els.mailboxesPrevPage) {
    els.mailboxesPrevPage.disabled = currentMailboxPage <= 1;
  }
  if (els.mailboxesNextPage) {
    els.mailboxesNextPage.disabled = currentMailboxPage >= totalPages;
  }
}

async function loadDomainUsage() {
  if (!els.domainUsageBody) {return;}
  try {
    els.domainUsageBody.textContent = '加载中…';
    const r = await api('/api/admin/stats/domains');
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      els.domainUsageBody.textContent = '加载失败：' + (t || r.status);
      return;
    }
    const data = await r.json();
    const list = Array.isArray(data.list) ? data.list : [];
    if (!list.length) {
      els.domainUsageBody.textContent = '暂无数据';
      return;
    }
    const rows = list.map(function(item) {
      const d = item.domain || '';
      const c = Number(item.mailbox_count || 0);
      const mc = Number(item.message_count || 0);
      const active = Number(item.is_active || 0) === 1;
      const statusText = active ? '活跃' : '停用';
      const statusClass = active ? 'status-ok' : 'status-warn';
      return (
        '<tr>' +
          '<td style="padding:4px 6px;font-family:monospace;">' + escapeHtml(d) + '</td>' +
          '<td style="padding:4px 6px;text-align:right;">' + c + '</td>' +
          '<td style="padding:4px 6px;text-align:right;">' + mc + '</td>' +
          '<td style="padding:4px 6px;text-align:center;"><span class="' + statusClass + '">' + statusText + '</span></td>' +
        '</tr>'
      );
    }).join('');
    const total = Number(data.total || 0);
    const active = Number(data.active || 0);
    const inactive = Number(data.inactive || 0);
    const summary = (
      '<div style="margin-bottom:8px;color:#64748b;">' +
        '活跃域名 ' + active + ' 个，已失效 ' + inactive + ' 个，总计 ' + total + ' 个' +
      '</div>'
    );
    els.domainUsageBody.innerHTML =
      summary +
      '<div style="max-height:220px;overflow:auto;border:1px solid #e2e8f0;border-radius:6px;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
          '<thead>' +
            '<tr style="background:#f8fafc;">' +
              '<th style="padding:4px 6px;text-align:left;">域名</th>' +
              '<th style="padding:4px 6px;text-align:right;">邮箱数量</th>' +
              '<th style="padding:4px 6px;text-align:right;">邮件数量</th>' +
              '<th style="padding:4px 6px;text-align:center;">状态</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            rows +
          '</tbody>' +
        '</table>' +
      '</div>';
  } catch (e) {
    els.domainUsageBody.textContent = '加载失败：' + (e && e.message ? e.message : e);
  }
}

function setForwardMsg(text, ok) {
  if (!els.forwardConfigMsg) return;
  els.forwardConfigMsg.textContent = text;
  els.forwardConfigMsg.style.color = ok ? '#16a34a' : '#dc2626';
}

async function initForwardConfig() {
  const input = els.forwardConfigInput;
  const saveBtn = els.forwardConfigSave;
  if (!input || !saveBtn) return;

  // 加载当前配置
  try {
    const r = await api('/api/config/forward');
    const data = await r.json();
    if (data && typeof data.forwardTo === 'string') {
      input.value = data.forwardTo;
    }
  } catch (e) { void e; }

  const save = async function() {
    const forwardTo = String(input.value || '').trim();
    setForwardMsg('保存中…', true);
    try {
      await api('/api/config/forward', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forwardTo })
      });
      setForwardMsg(forwardTo ? '✅ 已保存：' + escapeHtml(forwardTo) : '✅ 已关闭归档转发', true);
    } catch (e) {
      setForwardMsg('保存失败：' + (e && e.message ? e.message : e), false);
    }
  };

  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', function(ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
  });
}

function setTelegramStatusBadge(state) {
  if (!els.telegramStatusBadge) return;
  const el = els.telegramStatusBadge;
  if (state === 'ok') {
    el.textContent = '已连接';
    el.style.background = 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(22,163,74,0.1))';
    el.style.color = '#16a34a';
    el.style.borderColor = 'rgba(34,197,94,0.4)';
  } else if (state === 'warn') {
    el.textContent = '需关注';
    el.style.background = 'linear-gradient(135deg, rgba(234,179,8,0.18), rgba(202,138,4,0.12))';
    el.style.color = '#ca8a04';
    el.style.borderColor = 'rgba(234,179,8,0.5)';
  } else if (state === 'error') {
    el.textContent = '异常';
    el.style.background = 'linear-gradient(135deg, rgba(248,113,113,0.2), rgba(220,38,38,0.14))';
    el.style.color = '#dc2626';
    el.style.borderColor = 'rgba(248,113,113,0.6)';
  } else if (state === 'disabled') {
    el.textContent = '未启用';
    el.style.background = 'linear-gradient(135deg, rgba(148,163,184,0.18), rgba(148,163,184,0.08))';
    el.style.color = '#64748b';
    el.style.borderColor = 'rgba(148,163,184,0.5)';
  } else {
    el.textContent = '检查中';
    el.style.background = '';
    el.style.color = '';
    el.style.borderColor = '';
  }
}

async function loadTelegramStatus() {
  if (!els.telegramStatusContent) return;
  
  try {
    setTelegramStatusBadge('checking');
    if (els.telegramStatusLoading) els.telegramStatusLoading.style.display = 'block';
    if (els.telegramStatusContent) els.telegramStatusContent.style.display = 'none';
    
    const r = await api('/api/telegram/status');
    const data = await r.json();
    
    if (els.telegramStatusLoading) els.telegramStatusLoading.style.display = 'none';
    if (els.telegramStatusContent) els.telegramStatusContent.style.display = 'grid';
    
    if (!data || data.enabled === false) {
      setTelegramStatusBadge('disabled');
      if (els.tgExtra) els.tgExtra.textContent = '未配置 Telegram Bot (TELEGRAM_BOT_TOKEN)';
      // Clear other fields
      [els.tgBotName, els.tgBotId, els.tgBotUsername, els.tgChatId, els.tgToken, els.tgWebhook].forEach(el => {
        if (el) el.textContent = '-';
      });
      return;
    }
    
    // Fill Bot Info
    if (els.tgBotName) els.tgBotName.textContent = data.botInfo?.first_name || '-';
    if (els.tgBotId) els.tgBotId.textContent = data.botInfo?.id || '-';
    if (els.tgBotUsername) els.tgBotUsername.textContent = data.botInfo?.username ? '@' + data.botInfo.username : '-';
    if (els.tgChatId) els.tgChatId.textContent = data.chatId || '-';
    if (els.tgToken) els.tgToken.textContent = data.tokenMasked || '******';
    
    // Webhook URL
    if (els.tgWebhook) els.tgWebhook.textContent = data.url || '未设置';
    
    // Status & Extra Info
    const pending = Number(data.pendingUpdateCount || 0);
    const parts = [];
    if (pending > 0) parts.push(`待处理更新: ${pending}`);
    
    if (data.ok) {
      setTelegramStatusBadge('ok');
      parts.push('Webhook 正常工作');
      if (els.tgExtra) {
        els.tgExtra.className = 'telegram-info-value status-ok';
      }
    } else {
      const hasError = !!data.lastErrorDate || !!data.error;
      setTelegramStatusBadge(hasError ? 'error' : 'warn');
      if (data.lastErrorMessage) parts.push(`错误: ${data.lastErrorMessage}`);
      if (data.error) parts.push(`API错误: ${data.error}`);
      if (data.recommendedUrl && data.recommendedUrl !== data.url) {
         parts.push(`建议 URL: ${data.recommendedUrl}`);
      }
      if (els.tgExtra) {
        els.tgExtra.className = 'telegram-info-value status-error';
      }
    }
    
    if (els.tgExtra) els.tgExtra.textContent = parts.length > 0 ? parts.join(' | ') : '正常';
    
  } catch (e) {
    setTelegramStatusBadge('error');
    if (els.telegramStatusLoading) els.telegramStatusLoading.style.display = 'none';
    if (els.telegramStatusContent) {
      els.telegramStatusContent.style.display = 'grid';
      // Clear fields
      [els.tgBotName, els.tgBotId, els.tgBotUsername, els.tgChatId, els.tgToken, els.tgWebhook].forEach(el => {
        if (el) el.textContent = '-';
      });
      if (els.tgExtra) {
        els.tgExtra.className = 'telegram-info-value status-error';
        els.tgExtra.textContent = String(e && e.message ? e.message : e || '加载失败');
      }
    }
  }
}

if (els.telegramStatusRefresh) {
  els.telegramStatusRefresh.onclick = () => {
    loadTelegramStatus();
  };
}

if (els.telegramTest) {
  els.telegramTest.onclick = async () => {
    try {
      setButtonLoading(els.telegramTest, '发送测试消息…');
      const r = await api('/api/telegram/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (!r.ok) {
        const txt = await r.text();
        showToast('测试失败：' + txt, 'warn');
        return;
      }
      let data = null;
      try {
        data = await r.json();
      } catch (_) {
        data = null;
      }
      if (data && data.ok) {
        showToast('Telegram 连接测试成功，请在 Telegram 中查看通知', 'success');
      } else {
        const msg = data && (data.message || data.error) ? String(data.message || data.error) : '';
        showToast('测试失败：' + msg, 'warn');
      }
    } catch (e) {
      showToast('测试失败：' + (e && e.message ? e.message : e), 'warn');
    } finally {
      restoreButton(els.telegramTest);
    }
  };
}

if (els.telegramConnect) {
  els.telegramConnect.onclick = async () => {
    try {
      setButtonLoading(els.telegramConnect, '正在设置 Webhook…');
      const r = await api('/api/telegram/set-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (!r.ok) {
        const txt = await r.text();
        showToast('设置 Webhook 失败：' + txt, 'warn');
        return;
      }
      let data = null;
      try {
        data = await r.json();
      } catch (_) {
        data = null;
      }
      if (data && data.ok) {
        const url = data.url || '';
        showToast('Webhook 已更新' + (url ? '：' + url : ''), 'success');
        loadTelegramStatus();
      } else {
        const msg = data && (data.message || data.error) ? String(data.message || data.error) : '';
        showToast('设置 Webhook 失败：' + msg, 'warn');
      }
    } catch (e) {
      showToast('设置 Webhook 失败：' + (e && e.message ? e.message : e), 'warn');
    } finally {
      restoreButton(els.telegramConnect);
    }
  };
}

// 上一页
async function goToPrevPage() {
  if (currentPage > 1) {
    if (els.prevPage) els.prevPage.disabled = true;
    try {
      await loadUsers(currentPage - 1);
    } finally {
      // loadUsers 会调用 updatePaginationUI，那里会处理按钮状态
      // 但为了保险起见，如果加载失败，这里可以恢复
      if (els.prevPage && currentPage > 1) els.prevPage.disabled = false;
    }
  }
}

// 下一页  
async function goToNextPage() {
  const totalPages = Math.ceil(totalUsers / pageSize);
  if (currentPage < totalPages) {
    if (els.nextPage) els.nextPage.disabled = true;
    try {
      await loadUsers(currentPage + 1);
    } finally {
      if (els.nextPage && currentPage < totalPages) els.nextPage.disabled = false;
    }
  }
}

// 邮箱上一页
async function goToMailboxPrevPage() {
  if (currentMailboxPage > 1 && currentViewingUser) {
    if (els.mailboxesPrevPage) els.mailboxesPrevPage.disabled = true;
    try {
      await loadUserMailboxes(currentViewingUser.userId, currentViewingUser.username, currentMailboxPage - 1);
    } finally {
      if (els.mailboxesPrevPage && currentMailboxPage > 1) els.mailboxesPrevPage.disabled = false;
    }
  }
}

// 邮箱下一页  
async function goToMailboxNextPage() {
  const totalPages = Math.ceil(totalMailboxes / mailboxPageSize);
  if (currentMailboxPage < totalPages && currentViewingUser) {
    if (els.mailboxesNextPage) els.mailboxesNextPage.disabled = true;
    try {
      await loadUserMailboxes(currentViewingUser.userId, currentViewingUser.username, currentMailboxPage + 1);
    } finally {
      if (els.mailboxesNextPage && currentMailboxPage < totalPages) els.mailboxesNextPage.disabled = false;
    }
  }
}

window.promptSetLimit = async (userId, current) => {
  const v = prompt('设置邮箱上限（整数）：', String(current || 10));
  if (v === null) return;
  const n = Math.max(0, parseInt(v, 10) || 0);
  try{
    const r = await api(`/api/users/${userId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mailboxLimit: n }) });
    if (!r.ok){ const t = await r.text(); throw new Error(t); }
    showToast('已更新上限','success');
    await loadUsers();
    // 如果当前正在查看该用户的邮箱，重新加载其邮箱列表
    if (currentViewingUser && currentViewingUser.userId === parseInt(userId)) {
      await reloadCurrentUserMailboxes();
    }
  }catch(e){ showToast('更新失败：' + (e?.message||e), 'warn'); }
}

window.deleteUser = async (userId) => {
  try{
    const r = await api(`/api/users/${userId}`, { method:'DELETE' });
    if (!r.ok){ const t = await r.text(); throw new Error(t); }
    showToast('已删除用户','success');
    // 如果当前正在查看被删除用户的邮箱，清空状态和显示
    if (currentViewingUser && currentViewingUser.userId === parseInt(userId)) {
      currentViewingUser = null;
    }
    els.userMailboxes.innerHTML = '<div style="color:#666;padding:12px">请选择用户查看邮箱列表</div>';
    await loadUsers();
  }catch(e){ showToast('删除失败：' + (e?.message||e), 'warn'); }
}

// 切换发件权限
window.toggleSend = async (userId, current) => {
  const next = current ? 0 : 1;
  try{
    const r = await api(`/api/users/${userId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ can_send: next }) });
    if (!r.ok){ const t = await r.text(); throw new Error(t); }
    showToast(next ? '已允许该用户发件' : '已禁止该用户发件', 'success');
    await loadUsers();
    // 如果当前正在查看该用户的邮箱，重新加载其邮箱列表
    if (currentViewingUser && currentViewingUser.userId === parseInt(userId)) {
      await reloadCurrentUserMailboxes();
    }
  }catch(e){ showToast('操作失败：' + (e?.message||e), 'warn'); }
}

// 创建用户操作状态控制
let isCreatingUser = false;

// 创建用户
function resetCreateForm(){ els.uName.value=''; els.uPass.value=''; els.uRole.value='user'; }
els.uOpen.onclick = () => { resetCreateForm(); openModal(els.uModal); };
els.uCreate.onclick = async () => {
  // 防止重复点击
  if (isCreatingUser) {
    showToast('正在创建用户中，请稍候...', 'info');
    return;
  }
  
  const username = els.uName.value.trim();
  const password = els.uPass.value.trim();
  const role = els.uRole.value;
  if (!username){ showToast('请输入用户名','warn'); return; }
  try{
    isCreatingUser = true;
    setButtonLoading(els.uCreate, '创建中…');
    const r = await api('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password, role }) });
    if (!r.ok){ const t = await r.text(); throw new Error(t); }
    showToast('创建成功','success');
    closeModal(els.uModal);
    await loadUsers();
  }catch(e){ showToast('创建失败：' + (e?.message||e), 'warn'); }
  finally { 
    isCreatingUser = false;
    restoreButton(els.uCreate); 
  }
}

// 分配操作状态控制
let isAssigning = false;

// 分配邮箱
els.aOpen.onclick = () => openModal(els.aModal);
els.aAssign.onclick = async () => {
  // 防止重复点击
  if (isAssigning) {
    showToast('正在分配中，请稍候...', 'info');
    return;
  }
  
  const username = els.aName.value.trim();
  const addresses = els.aMail.value.trim().split('\n').map(addr => addr.trim()).filter(addr => addr);
  
  if (!username || addresses.length === 0){
    showToast('请输入用户名和至少一个邮箱地址','warn'); 
    return; 
  }
  
  // 验证邮箱格式
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalidEmails = addresses.filter(addr => !emailRegex.test(addr));
  if (invalidEmails.length > 0) {
    showToast(`邮箱格式错误：${invalidEmails.join(', ')}`,'warn');
    return;
  }
  
  try{
    isAssigning = true;
    setButtonLoading(els.aAssign, '正在分配…');
    let successCount = 0;
    let failCount = 0;
    
    for (const address of addresses) {
      try {
        const r = await api('/api/users/assign', { 
          method:'POST', 
          headers:{'Content-Type':'application/json'}, 
          body: JSON.stringify({ username, address: address.toLowerCase() }) 
        });
        if (r.ok) {
          successCount++;
        } else {
          const txt = await r.text();
          failCount++;
        }
      } catch (e) {
        failCount++;
      }
    }
    
    if (successCount > 0) {
      showToast(`成功分配 ${successCount} 个邮箱${failCount > 0 ? `，${failCount} 个失败` : ''}`,'success');
      closeModal(els.aModal);
      // 清空表单
      els.aName.value = '';
      els.aMail.value = '';
      // 刷新用户列表
      await loadUsers();
      // 如果当前正在查看某个用户的邮箱，重新加载其邮箱列表
      await reloadCurrentUserMailboxes();
    } else {
      showToast('所有邮箱分配失败','warn');
    }
  }catch(e){ 
    showToast('分配失败：' + (e?.message||e), 'warn'); 
  }
  finally { 
    isAssigning = false;
    restoreButton(els.aAssign); 
  }
}

// 取消分配操作状态控制
let isUnassigning = false;

// 取消分配邮箱
els.unassignOpen.onclick = () => openModal(els.unassignModal);
els.unassignSubmit.onclick = async () => {
  // 防止重复点击
  if (isUnassigning) {
    showToast('正在取消分配中，请稍候...', 'info');
    return;
  }
  
  const username = els.unassignName.value.trim();
  const addresses = els.unassignMail.value.trim().split('\n').map(addr => addr.trim()).filter(addr => addr);
  
  if (!username || addresses.length === 0){
    showToast('请输入用户名和至少一个邮箱地址','warn'); 
    return; 
  }
  
  // 验证邮箱格式
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalidEmails = addresses.filter(addr => !emailRegex.test(addr));
  if (invalidEmails.length > 0) {
    showToast(`邮箱格式错误：${invalidEmails.join(', ')}`,'warn');
    return;
  }
  
  try{
    isUnassigning = true;
    setButtonLoading(els.unassignSubmit, '正在取消分配…');
    let successCount = 0;
    let failCount = 0;
    
    for (const address of addresses) {
      try {
        const r = await api('/api/users/unassign', { 
          method:'POST', 
          headers:{'Content-Type':'application/json'}, 
          body: JSON.stringify({ username, address: address.toLowerCase() }) 
        });
        if (r.ok) {
          successCount++;
        } else {
          const txt = await r.text();
          failCount++;
        }
      } catch (e) {
        failCount++;
      }
    }
    
    if (successCount > 0) {
      showToast(`成功取消分配 ${successCount} 个邮箱${failCount > 0 ? `，${failCount} 个失败` : ''}`,'success');
      closeModal(els.unassignModal);
      // 清空表单
      els.unassignName.value = '';
      els.unassignMail.value = '';
      // 刷新用户列表
      await loadUsers();
      // 如果当前正在查看某个用户的邮箱，重新加载其邮箱列表
      await reloadCurrentUserMailboxes();
    } else {
      showToast('所有邮箱取消分配失败','warn');
    }
  }catch(e){ 
    showToast('取消分配失败：' + (e?.message||e), 'warn'); 
  }
  finally { 
    isUnassigning = false;
    restoreButton(els.unassignSubmit); 
  }
}

// 单个邮箱取消分配
window.unassignSingleMailbox = async (username, address) => {
  // 立即捕获参数值，避免闭包问题
  const capturedUsername = String(username);
  const capturedAddress = String(address);
  
  // 防止同时进行多个单个取消分配操作
  if (isUnassigning) {
    showToast('正在取消分配中，请稍候...', 'info');
    return;
  }
  
  openAdminConfirm(`确定要取消用户 "${capturedUsername}" 对邮箱 "${capturedAddress}" 的分配吗？`, async () => {
    try {
      isUnassigning = true;
      const r = await api('/api/users/unassign', { 
        method:'POST', 
        headers:{'Content-Type':'application/json'}, 
        body: JSON.stringify({ username: capturedUsername, address: capturedAddress }) 
      });
      if (r.ok) {
        showToast('取消分配成功','success');
        // 刷新用户列表
        await loadUsers();
        // 如果当前正在查看该用户的邮箱，重新加载其邮箱列表
        if (currentViewingUser && currentViewingUser.username === capturedUsername) {
          await reloadCurrentUserMailboxes();
        }
      } else {
        const txt = await r.text();
        showToast('取消分配失败：' + txt, 'warn');
      }
    } catch (e) {
      showToast('取消分配失败：' + (e?.message || e), 'warn');
    } finally {
      isUnassigning = false;
    }
  });
}

// 统一按钮加载态（与 app.js 一致的极简实现）
function setButtonLoading(button, text){
  if (!button) return;
  if (button.dataset.loading === '1') return;
  button.dataset.loading = '1';
  button.dataset.originalHtml = button.innerHTML;
  button.disabled = true;
  const txt = text || '处理中…';
  button.innerHTML = `<div class="spinner"></div><span style="margin-left:8px">${txt}</span>`;
}
function restoreButton(button){
  if (!button) return;
  const html = button.dataset.originalHtml;
  if (html){ button.innerHTML = html; }
  button.disabled = false;
  delete button.dataset.loading;
  delete button.dataset.originalHtml;
}

// 导航
els.back.onclick = () => { 
  // 防止重复点击
  const now = Date.now();
  if (isNavigating || (now - lastNavigateTime < 1000)) {
    return;
  }
  isNavigating = true;
  lastNavigateTime = now;
  
  // 使用 location.href 而不是 replace，确保创建历史记录条目以支持前进后退
  location.href = '/templates/loading.html?redirect=%2F&status=' + encodeURIComponent('正在返回邮箱…'); 
  
  // 安全重置导航状态（防止页面未跳转导致按钮永久失效）
  navigationTimer = setTimeout(() => {
    isNavigating = false;
  }, 2000);
};
els.logout.onclick = async () => { 
  try{ fetch('/api/logout', { method:'POST', keepalive: true }); }catch{}
  try{ sessionStorage.setItem('mf:just_logged_out', '1'); }catch(_){ }
  location.replace('/html/login.html?from=logout');
};

// 设置邮箱列表的初始提示
els.userMailboxes.innerHTML = '<div style="color:#666;padding:12px;text-align:center;">请点击用户列表中的"邮箱"按钮查看用户邮箱</div>';
// 初始化邮箱数量显示
if (els.mailboxesCount) els.mailboxesCount.textContent = '（0 邮箱）';

// ===== 二级页面：编辑用户 =====
window.openEdit = (id, name, role, limit, canSend) => {
  els.editModal.classList.add('show');
  if (els.editName) els.editName.value = name;
  if (els.editUserDisplay){ els.editUserDisplay.textContent = name; }
  els.editRoleCheck.checked = (String(role) === 'admin');
  els.editLimit.value = Number(limit||0);
  els.editSendCheck.checked = !!canSend;
  els.editNewName.value = '';
  els.editPass.value = '';
  
  // 将参数保存到模态框的数据属性中，避免闭包变量污染
  els.editModal.dataset.currentUserId = String(id);
  els.editModal.dataset.currentUserName = String(name);
};
// 编辑用户操作状态控制
let isEditingUser = false;

// 编辑模态框事件处理器（独立于openEdit函数，避免闭包问题）
els.editSave.onclick = async () => {
  // 防止重复点击
  if (isEditingUser) {
    showToast('正在保存中，请稍候...', 'info');
    return;
  }
  
  try{
    // 从模态框的数据属性中获取参数，避免闭包变量被覆盖
    const currentUserId = els.editModal.dataset.currentUserId;
    const currentUserName = els.editModal.dataset.currentUserName;
    
    if (!currentUserId) {
      showToast('无效的用户ID', 'warn');
      return;
    }
    
    isEditingUser = true;
    setButtonLoading(els.editSave, '保存中…');
    const body = { 
      mailboxLimit: Number(els.editLimit.value||0), 
      can_send: els.editSendCheck.checked ? 1 : 0, 
      role: els.editRoleCheck.checked ? 'admin' : 'user' 
    };
    const newName = (els.editNewName.value||'').trim();
    const newPass = (els.editPass.value||'').trim();
    if (newName) body.username = newName;
    if (newPass) body.password = newPass;
    
    const r = await api(`/api/users/${currentUserId}`, { 
      method:'PATCH', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify(body) 
    });
    if (!r.ok){ const t = await r.text(); throw new Error(t); }
    
    showToast('已保存','success');
    els.editModal.classList.remove('show');
    
    // 如果当前正在查看该用户的邮箱，且用户名被修改了，更新当前查看用户的信息
    if (currentViewingUser && currentViewingUser.userId === parseInt(currentUserId) && newName) {
      currentViewingUser.username = newName;
    }
    
    await loadUsers();
    // 如果当前正在查看该用户的邮箱，重新加载其邮箱列表
    if (currentViewingUser && currentViewingUser.userId === parseInt(currentUserId)) {
      await reloadCurrentUserMailboxes();
    }
  }catch(e){ 
    showToast('保存失败：' + (e?.message||e), 'warn'); 
  }
  finally { 
    isEditingUser = false;
    restoreButton(els.editSave); 
  }
};

els.editDelete.onclick = () => {
  // 从模态框的数据属性中获取参数，避免闭包变量被覆盖
  const currentUserId = els.editModal.dataset.currentUserId;
  const currentUserName = els.editModal.dataset.currentUserName;
  
  if (!currentUserId) {
    showToast('无效的用户ID', 'warn');
    return;
  }
  
  openAdminConfirm(
    `确定删除用户 "${currentUserName}" 及其关联邮箱绑定（不会删除邮箱实体与邮件）？`, 
    async () => { 
      await deleteUser(currentUserId); 
    }
  );
};

// 关闭模态框并重置状态
function closeModalAndResetState(modal) {
  modal?.classList?.remove('show');
  // 重置所有操作状态
  isCreatingUser = false;
  isAssigning = false;
  isUnassigning = false;
  isEditingUser = false;
  
  // 如果是确认模态框，也要清理其状态
  if (modal === els.adminConfirmModal) {
    delete modal._currentOnOk;
    delete modal._confirmId;
    delete modal._isProcessing;
    if (currentAdminConfirmController) {
      currentAdminConfirmController.abort();
      currentAdminConfirmController = null;
    }
  }
}

els.editClose.onclick = () => closeModalAndResetState(els.editModal);
els.editCancel.onclick = () => closeModalAndResetState(els.editModal);

// 重写其他模态框的关闭事件，确保状态重置
els.uClose.onclick = () => closeModalAndResetState(els.uModal);
els.uCancel.onclick = () => closeModalAndResetState(els.uModal);
els.aClose.onclick = () => closeModalAndResetState(els.aModal);
els.aCancel.onclick = () => closeModalAndResetState(els.aModal);
els.unassignClose.onclick = () => closeModalAndResetState(els.unassignModal);
els.unassignCancel.onclick = () => closeModalAndResetState(els.unassignModal);

// 确认模态框的关闭事件（这些会在 openAdminConfirm 中动态绑定，这里只是备用）
if (els.adminConfirmClose) {
  els.adminConfirmClose.onclick = () => closeModalAndResetState(els.adminConfirmModal);
}
if (els.adminConfirmCancel) {
  els.adminConfirmCancel.onclick = () => closeModalAndResetState(els.adminConfirmModal);
}

// 点击遮罩关闭所有模态（不保存）
document.addEventListener('mousedown', (e) => {
  const opened = document.querySelectorAll('.modal.show');
  opened.forEach(m => {
    const card = m.querySelector('.modal-card');
    if (card && !card.contains(e.target)){
      closeModalAndResetState(m);
    }
  });
});

// 分页按钮事件绑定
if (els.prevPage) els.prevPage.onclick = goToPrevPage;
if (els.nextPage) els.nextPage.onclick = goToNextPage;
if (els.usersRefresh) els.usersRefresh.onclick = async () => {
  setButtonLoading(els.usersRefresh, '刷新中');
  try {
    await loadUsers();
    await reloadCurrentUserMailboxes();
  } finally {
    restoreButton(els.usersRefresh);
  }
};

// 邮箱分页按钮事件绑定
if (els.mailboxesPrevPage) els.mailboxesPrevPage.onclick = goToMailboxPrevPage;
if (els.mailboxesNextPage) els.mailboxesNextPage.onclick = goToMailboxNextPage;
if (els.mailboxesRefresh) els.mailboxesRefresh.onclick = async () => {
  setButtonLoading(els.mailboxesRefresh, '刷新中');
  try {
    await reloadCurrentUserMailboxes();
  } finally {
    restoreButton(els.mailboxesRefresh);
  }
};

// 重置导航状态的函数
function resetNavigationState() {
  if (isNavigating) {
    isNavigating = false;
    if (navigationTimer) {
      clearTimeout(navigationTimer);
      navigationTimer = null;
    }
  }
}

// 页面可见性变化时重置导航状态
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    resetNavigationState();
  }
});

// 页面获得焦点时重置导航状态
window.addEventListener('focus', resetNavigationState);

// 页面失去焦点时重置导航状态（处理浏览器回退情况）
window.addEventListener('blur', () => {
  setTimeout(resetNavigationState, 100);
});

// 页面初始化
(async () => {
  try {
    // 初始化时重置导航状态
    resetNavigationState();
    
    const r = await fetch('/api/session');
    if (!r.ok) {
      if (els.demoBanner) {
        els.demoBanner.remove();
      }
      return;
    }
    const s = await r.json();
    let siteMode = 'selfhost';
    try {
      if (typeof window !== 'undefined' && window.__SITE_MODE__) {
        const raw = String(window.__SITE_MODE__).trim().toLowerCase();
        siteMode = raw === 'demo' ? 'demo' : 'selfhost';
      }
    } catch(_){ }
    if (siteMode === 'demo' && s && s.role === 'guest' && els.demoBanner) {
      els.demoBanner.style.display = 'block';
    } else if (els.demoBanner) {
      els.demoBanner.remove();
    }
    
    await loadUsers();
    await loadTelegramStatus();
    await loadDomainUsage();
    initForwardConfig();
  } catch(_) {
    if (els.demoBanner) {
      els.demoBanner.remove();
    }
    try {
      await loadUsers();
      await loadTelegramStatus();
      await loadDomainUsage();
      initForwardConfig();
    } catch(e) {
      void e;
    }
  }
})();

/**
 * 从用户管理页面跳转到首页并选中指定邮箱
 * @param {string} address - 邮箱地址
 * @param {Event} event - 点击事件
 */
window.selectMailboxAndGoToHomepage = function(address, event) {
  try {
    // 防止重复点击
    if (isNavigating) {
      return;
    }
    
    // 检查基本参数
    if (!address) {
      return;
    }
    
    // 检查时间间隔，防止极快的重复点击
    const now = Date.now();
    if (now - lastNavigateTime < 300) {
      return;
    }
    
    isNavigating = true;
    lastNavigateTime = now;
    
    // 保存选中的邮箱到 sessionStorage，首页会自动恢复
    // 使用通用键名，首页会根据用户身份自动处理
    try {
      sessionStorage.setItem('mf:currentMailbox', address);
      // 同时保存一个临时标记，让首页知道这是从管理页跳转过来的
      sessionStorage.setItem('mf:fromAdmin', '1');
    } catch(_) {}
    
    // 显示短时间跳转提示
    showToast(`正在跳转到邮箱：${address}`, 'info', 500);
    
    // 跨页面导航：等待toast播放完成后跳转
    navigationTimer = setTimeout(() => {
      navigationTimer = null;
      window.location.href = '/templates/loading.html?redirect=%2F%23inbox&status=' + encodeURIComponent('正在跳转到邮箱…');
    }, 800);
    
    // 备用重置机制：3秒后强制重置状态，防止状态卡死
    setTimeout(() => {
      resetNavigationState();
    }, 3000);
    
  } catch(err) {
    showToast('跳转失败', 'error');
    isNavigating = false;
    if (navigationTimer) {
      clearTimeout(navigationTimer);
      navigationTimer = null;
    }
  }
};
