/**
 * Meet up Recurring Crew Scheduler - Frontend Application
 * Connects to Express + Supabase Auth/Storage + Gmail SMTP Service
 */

const state = {
  token: localStorage.getItem('meetup_token') || localStorage.getItem('tossup_token') || '',
  currentUser: null,
  allUsers: [],
  weekOffset: 0,
  weekMeta: null,
  timeSlots: [],
  groups: [],
  pendingInvitations: [],
  activeGroupId: null,
  activeGroup: null,
  managerModeOverride: undefined,
  compareGroupIds: [],
  multiGroupManagerMode: true,
  multiGroupOverlap: null,
  confirmedMeetings: [],
  votingHistory: [],
  meetingHistory: [],
  emailLogs: [],
  // Interactive drag-to-vote state
  mySlots: {},
  isDragging: false,
  dragPaintMode: true, // true = selecting, false = deselecting
  saveDebounceTimer: null,
  theme: localStorage.getItem('meetup_theme') || localStorage.getItem('tossup_theme') || 'warm-paper',
  colorMode: localStorage.getItem('meetup_mode') || localStorage.getItem('tossup_mode') || 'light'
};

// ============================================================================
// 1. INITIALIZATION & THEME ENGINE
// ============================================================================

function applyThemeAndMode(theme, mode, persistRemote = false) {
  state.theme = theme || state.theme;
  state.colorMode = mode || state.colorMode;

  document.documentElement.setAttribute('data-theme', state.theme);
  document.documentElement.setAttribute('data-mode', state.colorMode);

  localStorage.setItem('meetup_theme', state.theme);
  localStorage.setItem('meetup_mode', state.colorMode);

  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.setTheme === state.theme);
  });

  const label = document.getElementById('colorModeLabel');
  if (label) {
    label.textContent = state.colorMode === 'dark' ? 'Chế độ Sáng' : 'Chế độ Tối';
  }

  if (persistRemote && state.token) {
    apiFetch('/api/auth/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ theme: state.theme, color_mode: state.colorMode })
    }).catch(() => {});
  }
}

function showToast(message) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const item = document.createElement('div');
  item.className = 'toast-item';
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.25s ease';
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  if (state.currentUser?.email) {
    headers['x-user-email'] = state.currentUser.email;
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data;
}

// ============================================================================
// 2. RENDER TOSS-UP SEGMENTED OVERLAP CARDS (EXACT SCREENSHOT MATCH)
// ============================================================================

function renderTossupSegmentedCardHtml(card, isInteractive = true) {
  const total = Math.max(card.totalMembers || 4, 1);
  const free = card.freeCount || 0;
  const isBest = Boolean(card.isBestOverlap);
  const fillClass = isBest || card.isFullOverlap ? 'filled-sage' : 'filled-coral';
  const fractionTone = isBest || card.isFullOverlap ? 'tone-sage' : free > 0 ? 'tone-coral' : 'tone-muted';

  // Build 4-segment bar (or total members count)
  const segCount = 4;
  const filledSegs = Math.round((free / total) * segCount);
  let segHtml = '';
  for (let i = 0; i < segCount; i++) {
    segHtml += `<span class="t-seg ${i < filledSegs ? fillClass : ''}"></span>`;
  }

  const timeSubtitle =
    free > 0
      ? `${card.timeRange}${isBest ? ' · best overlap' : ''}${card.managerFree ? ' · Manager' : ''}`
      : card.timeRange;

  return `
    <div class="tossup-day-card ${isBest ? 'best-overlap' : ''}"
         data-day-code="${card.dayCode}"
         data-date-iso="${card.dateIso || ''}"
         data-start-time="${card.startTime || '19:30'}"
         data-end-time="${card.endTime || '21:00'}"
         data-free-count="${free}"
         data-manager-free="${card.managerFree ? 'true' : 'false'}"
         title="${isInteractive ? 'Bấm để chốt lịch họp vào khung giờ này' : ''}">
      <div class="t-day-col">
        <div class="t-day-code">${card.dayCode}</div>
        <div class="t-day-num tabular">${card.dayNum}</div>
      </div>
      <div class="t-bar-col">
        <div class="t-segments">${segHtml}</div>
        <div class="t-time-label tabular">${timeSubtitle}</div>
      </div>
      <div class="t-count-col">
        <span class="t-fraction tabular ${fractionTone}">${free}/${total}</span>
      </div>
    </div>
  `;
}

// ============================================================================
// 3. PUBLIC BOOTSTRAP & AUTH GATE (LOGIN, REGISTER OTP, RESET PASSWORD OTP)
// ============================================================================

async function loadPublicBootstrap() {
  try {
    await apiFetch('/api/public/bootstrap');
  } catch (err) {
    console.warn('Bootstrap info:', err.message);
  }
}

function clearAuthFormInputs() {
  const ids = [
    'loginEmail',
    'loginPassword',
    'regName',
    'regEmail',
    'regPassword',
    'regOtpInput',
    'resetEmail',
    'resetOtpInput',
    'resetNewPassword'
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function setupAuthForms() {
  // Clear any cached credentials on page open to ensure strict security
  clearAuthFormInputs();

  // Pre-fill email only if arriving from an official invitation link (?invited_email=...)
  const urlParams = new URLSearchParams(window.location.search);
  const invitedEmail = urlParams.get('invited_email');
  if (invitedEmail) {
    const loginEmailEl = document.getElementById('loginEmail');
    const regEmailEl = document.getElementById('regEmail');
    if (loginEmailEl) loginEmailEl.value = invitedEmail;
    if (regEmailEl) regEmailEl.value = invitedEmail;
  }

  // Auth Tab Switcher
  document.querySelectorAll('[data-auth-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-auth-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.authTab;
      document.getElementById('loginForm').style.display = target === 'login' ? 'block' : 'none';
      document.getElementById('registerForm').style.display = target === 'register' ? 'block' : 'none';
      document.getElementById('resetForm').style.display = target === 'reset' ? 'block' : 'none';
      clearAuthFormInputs();
    });
  });

  // 1. Login Form
  document.getElementById('loginForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.token = data.token;
      state.currentUser = data.user;
      localStorage.setItem('meetup_token', data.token);
      localStorage.setItem('tossup_token', data.token);
      clearAuthFormInputs();
      showToast(`Chào mừng trở lại, ${data.user.name}!`);
      await enterProtectedWorkspace();
    } catch (err) {
      showToast(err.message);
    }
  });

  // 2. Send Register OTP Button (Strictly sends to email, never displays OTP on screen)
  document.getElementById('sendRegOtpBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const role = document.getElementById('regRole').value;
    const btn = document.getElementById('sendRegOtpBtn');

    if (!name || !email || !password) {
      showToast('Vui lòng điền đầy đủ Họ tên, Email và Mật khẩu trước khi nhận mã OTP.');
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Đang gửi mã OTP về hộp thư...';
      const data = await apiFetch('/api/auth/request-register-otp', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, role })
      });
      document.getElementById('regOtpVerifyBox').style.display = 'block';
      const hintEl = document.getElementById('regOtpHintText');
      if (hintEl) {
        hintEl.textContent = data.message;
      }
      const otpInput = document.getElementById('regOtpInput');
      if (otpInput) {
        otpInput.value = '';
        otpInput.focus();
      }
      showToast(data.message);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Gửi lại mã OTP về Email';
    }
  });

  // Verify Register OTP Submit
  document.getElementById('registerForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('regEmail').value.trim();
    const otp = document.getElementById('regOtpInput').value.trim();
    if (!otp) {
      showToast('Vui lòng nhập mã OTP 6 số nhận được trong Email của bạn.');
      return;
    }
    try {
      const data = await apiFetch('/api/auth/verify-register-otp', {
        method: 'POST',
        body: JSON.stringify({ email, otp })
      });
      state.token = data.token;
      state.currentUser = data.user;
      localStorage.setItem('meetup_token', data.token);
      localStorage.setItem('tossup_token', data.token);
      showToast(data.message);
      await enterProtectedWorkspace();
    } catch (err) {
      showToast(err.message);
    }
  });

  // 3. Send Password Reset OTP Button (Strictly sends to email, never displays OTP on screen)
  document.getElementById('sendResetOtpBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('resetEmail').value.trim();
    const btn = document.getElementById('sendResetOtpBtn');
    if (!email) {
      showToast('Vui lòng nhập địa chỉ Email cần khôi phục mật khẩu.');
      return;
    }
    try {
      btn.disabled = true;
      btn.textContent = 'Đang gửi mã OTP khôi phục...';
      const data = await apiFetch('/api/auth/request-reset-otp', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      document.getElementById('resetOtpVerifyBox').style.display = 'block';
      const hintEl = document.getElementById('resetOtpHintText');
      if (hintEl) {
        hintEl.textContent = data.message;
      }
      const otpInput = document.getElementById('resetOtpInput');
      if (otpInput) {
        otpInput.value = '';
        otpInput.focus();
      }
      showToast(data.message);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Gửi lại mã OTP khôi phục';
    }
  });

  // Confirm Reset Password Submit
  document.getElementById('resetForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('resetEmail').value.trim();
    const otp = document.getElementById('resetOtpInput').value.trim();
    const newPassword = document.getElementById('resetNewPassword').value;
    try {
      const data = await apiFetch('/api/auth/confirm-reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, otp, newPassword })
      });
      state.token = data.token;
      state.currentUser = data.user;
      localStorage.setItem('meetup_token', data.token);
    localStorage.setItem('tossup_token', data.token);
      showToast(data.message);
      await enterProtectedWorkspace();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    state.token = '';
    state.currentUser = null;
    localStorage.removeItem('meetup_token');
    localStorage.removeItem('tossup_token');
    clearAuthFormInputs();
    document.getElementById('authGateView').style.display = 'block';
    document.getElementById('protectedWorkspaceView').style.display = 'none';
    document.getElementById('workspaceNav').style.display = 'none';
    document.getElementById('userHeaderBox').style.display = 'none';
    showToast('Đã đăng xuất khỏi phiên làm việc.');
  });
}

// ============================================================================
// 4. PROTECTED WORKSPACE DASHBOARD & DRAG-TO-VOTE ENGINE
// ============================================================================

async function enterProtectedWorkspace() {
  document.getElementById('authGateView').style.display = 'none';
  document.getElementById('protectedWorkspaceView').style.display = 'block';
  document.getElementById('workspaceNav').style.display = 'flex';
  document.getElementById('userHeaderBox').style.display = 'flex';

  await loadDashboardData();
  checkAndShowTutorial();
}

async function loadDashboardData() {
  try {
    const params = new URLSearchParams({
      weekOffset: String(state.weekOffset)
    });
    if (state.activeGroupId) params.set('groupId', state.activeGroupId);
    if (state.managerModeOverride !== undefined) {
      params.set('managerMode', String(state.managerModeOverride));
    }
    if (state.compareGroupIds.length > 0) {
      params.set('compareGroups', state.compareGroupIds.join(','));
    }
    params.set('multiManagerMode', String(state.multiGroupManagerMode));

    const data = await apiFetch(`/api/dashboard?${params.toString()}`);

    state.currentUser = data.currentUser;
    state.allUsers = data.allUsers || [];
    state.weekMeta = data.weekMeta;
    state.timeSlots = data.timeSlots || [];
    state.groups = data.groups || [];
    state.pendingInvitations = data.pendingInvitations || [];
    state.activeGroup = data.activeGroup;
    state.activeGroupId = data.activeGroup?.id || null;
    state.mySlots = structuredClone(data.activeGroup?.mySlots || {});
    state.multiGroupOverlap = data.multiGroupOverlap;
    state.confirmedMeetings = data.confirmedMeetings || [];
    state.votingHistory = data.votingHistory || [];
    state.meetingHistory = data.meetingHistory || [];
    state.emailLogs = data.emailLogs || [];

    if (state.compareGroupIds.length === 0) {
      state.compareGroupIds = state.groups.map(g => g.id);
    }

    renderPendingInvitationsBanner();
    renderTopHeaderAndWeekBar();
    renderSidebarGroupsAndManagerBox();
    renderDragToVoteGrid();
    renderSingleGroupOverlapPanel();
    renderMultiGroupComparisonView();
    renderConfirmedCalendarView();
    renderEmailLogsView();
  } catch (err) {
    // If token expired, fallback to Auth Gate
    if (err.message.includes('UNAUTHORIZED') || err.message.includes('Phiên đăng nhập')) {
      state.token = '';
      localStorage.removeItem('meetup_token');
      localStorage.removeItem('tossup_token');
      document.getElementById('authGateView').style.display = 'block';
      document.getElementById('protectedWorkspaceView').style.display = 'none';
      document.getElementById('workspaceNav').style.display = 'none';
      document.getElementById('userHeaderBox').style.display = 'none';
    } else {
      showToast(err.message);
    }
  }
}

function renderPendingInvitationsBanner() {
  const bannerEl = document.getElementById('pendingInvitationsBanner');
  if (!bannerEl) return;

  const list = state.pendingInvitations || [];
  if (list.length === 0) {
    bannerEl.style.display = 'none';
    bannerEl.innerHTML = '';
    return;
  }

  bannerEl.style.display = 'block';
  bannerEl.innerHTML = `
    <div class="panel-card" style="background:var(--sage-soft);border:1.5px solid var(--sage);">
      <div style="font-size:14px;font-weight:700;color:var(--sage);margin-bottom:10px;">
        Bạn có ${list.length} lời mời tham gia nhóm đang chờ xác nhận:
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${list
          .map(
            inv => `
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;background:var(--surface-elevated);padding:12px 16px;border-radius:12px;">
            <div>
              <div style="font-size:14.5px;font-weight:700;">Nhóm: ${inv.group_name}</div>
              <div style="font-size:12.5px;color:var(--muted);">
                Người mời: <strong>${inv.inviter_name}</strong> (${inv.inviter_email})
              </div>
            </div>
            <div style="display:flex;gap:8px;">
              <button type="button" class="btn btn-sage btn-sm" data-respond-invite="${inv.id}" data-invite-action="accept">
                Đồng ý tham gia
              </button>
              <button type="button" class="btn btn-ghost btn-sm" data-respond-invite="${inv.id}" data-invite-action="decline">
                Từ chối
              </button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;

  bannerEl.querySelectorAll('[data-respond-invite]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inviteId = btn.dataset.respondInvite;
      const action = btn.dataset.inviteAction;
      try {
        btn.disabled = true;
        const res = await apiFetch(`/api/invitations/${inviteId}/respond`, {
          method: 'POST',
          body: JSON.stringify({ action })
        });
        if (res.groupId) {
          state.activeGroupId = res.groupId;
        }
        showToast(res.message);
        await loadDashboardData();
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
      }
    });
  });
}

function renderTopHeaderAndWeekBar() {
  const userPill = document.getElementById('activeUserPill');
  if (userPill && state.currentUser) {
    userPill.textContent = `${state.currentUser.name} (${state.currentUser.role === 'manager' ? 'Manager' : 'Member'})`;
  }

  const emailBadge = document.getElementById('workspaceUserEmailBadge');
  if (emailBadge && state.currentUser) {
    emailBadge.textContent = `${state.currentUser.name} · ${state.currentUser.email}`;
  }

  const topBarEl = document.getElementById('topMembersVotedBar');
  if (topBarEl) {
    topBarEl.style.display = state.groups.length > 0 ? 'flex' : 'none';
  }

  document.getElementById('navMultiCount').textContent = String(state.confirmedMeetings.length);
  document.getElementById('navCalendarCount').textContent = String(state.confirmedMeetings.length);

  if (state.weekMeta) {
    document.getElementById('currentWeekBadge').textContent = state.weekMeta.weekKey;
    document.getElementById('currentWeekRange').textContent = state.weekMeta.rangeLabel;
  }
}

function renderSidebarGroupsAndManagerBox() {
  const listEl = document.getElementById('sidebarGroupList');
  if (!listEl) return;

  if (state.groups.length === 0) {
    listEl.innerHTML = `
      <div style="padding:16px;background:var(--surface-elevated);border-radius:12px;font-size:12.5px;color:var(--muted);line-height:1.5;">
        Tài khoản của bạn hiện chưa có nhóm nào. Hãy bấm <strong>"+ Tạo nhóm"</strong> ở trên hoặc nhập mã mời để bắt đầu!
      </div>
    `;
    const mgrCard = document.getElementById('managerModeCard');
    const membersSec = document.getElementById('groupMembersSection');
    if (mgrCard) mgrCard.style.display = 'none';
    if (membersSec) membersSec.style.display = 'none';
    return;
  }

  const mgrCard = document.getElementById('managerModeCard');
  const membersSec = document.getElementById('groupMembersSection');
  if (mgrCard) mgrCard.style.display = 'block';
  if (membersSec) membersSec.style.display = 'block';

  const currentEmailLower = (state.currentUser?.email || '').toLowerCase();

  listEl.innerHTML = state.groups
    .map(g => {
      const isAct = g.id === state.activeGroupId;
      const best = g.overlap?.bestRecommendation;
      const bestText = best
        ? `${best.dayCode} ${best.timeRange} (${best.freeCount}/${best.totalMembers})`
        : 'Chưa có lịch trùng';

      const isJoinedMember = (g.members || []).some(
        m => (m.user_email || '').toLowerCase() === currentEmailLower
      );

      return `
        <div class="group-item ${isAct ? 'active' : ''}" data-select-group="${g.id}">
          <div class="group-item-top">
            <span class="group-item-name">${g.name}</span>
            <span class="pill-badge ${best?.isFullOverlap ? 'pill-sage' : 'pill-coral'} tabular">
              ${g.overlap?.votedMembersCount || 0}/${g.overlap?.totalMembers || 1}
            </span>
          </div>
          <div class="group-item-meta">
            ${
              isJoinedMember && g.invite_code
                ? `<span title="Chỉ thành viên trong nhóm mới thấy mã mời này">Mã mời: <strong>${g.invite_code}</strong></span>`
                : `<span>Thành viên nhóm</span>`
            }
            <span class="tabular">${bestText}</span>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('[data-select-group]').forEach(el => {
    el.addEventListener('click', () => {
      state.activeGroupId = el.dataset.selectGroup;
      state.managerModeOverride = undefined;
      loadDashboardData();
    });
  });

  // Manager Mode Box
  const grp = state.activeGroup;
  if (!grp) return;

  const mgrEnabled = Boolean(grp.overlap?.managerMode);
  const mgrToggle = document.getElementById('managerModeToggle');
  const mgrNote = document.getElementById('managerModeStatusNote');
  const mgrNameEl = document.getElementById('managerNameLabel');

  const managerMember = (grp.members || []).find(
    m => m.user_email.toLowerCase() === (grp.manager_email || '').toLowerCase() || m.role === 'manager'
  );
  if (mgrNameEl) mgrNameEl.textContent = managerMember ? managerMember.user_name : grp.manager_email;

  mgrCard?.classList.toggle('active', mgrEnabled);
  mgrToggle?.classList.toggle('on', mgrEnabled);
  mgrToggle?.setAttribute('aria-checked', String(mgrEnabled));

  if (mgrNote) {
    mgrNote.textContent = mgrEnabled
      ? 'Đang BẬT: Chỉ đề xuất khung giờ mà Manager rảnh & ưu tiên trọng số cao nhất.'
      : 'Đang TẮT: Đề xuất theo số đông thành viên rảnh nhất (kể cả khi Manager bận).';
    mgrNote.style.color = mgrEnabled ? 'var(--sage)' : 'var(--coral)';
  }

  // Render top horizontal voted members strip
  const ratioLabel = document.getElementById('groupVotedRatioLabel');
  if (ratioLabel) {
    ratioLabel.textContent = `${grp.overlap?.votedMembersCount || 0}/${grp.members?.length || 0} đã vote`;
  }

  const membersEl = document.getElementById('groupMembersList');
  if (membersEl) {
    membersEl.innerHTML = (grp.members || [])
      .map(m => {
        const hasVoted = (grp.allVotesForWeek || []).some(
          v => v.user_email.toLowerCase() === m.user_email.toLowerCase()
        );
        return `
          <div class="member-top-pill ${hasVoted ? 'voted' : 'unvoted'}" title="${m.user_name} (${m.user_email}) · ${hasVoted ? 'Đã báo lịch rảnh' : 'Chưa vote tuần này'}">
            <span class="avatar-dot" style="background:${m.avatar_color || '#3D7A5A'};"></span>
            <span class="member-top-name">${m.user_name}${m.role === 'manager' ? '<span class="mgr-badge">Manager</span>' : ''}</span>
            <span class="member-top-status ${hasVoted ? 'status-voted' : 'status-unvoted'}">
              ${hasVoted ? 'Đã vote' : 'Chưa'}
            </span>
          </div>
        `;
      })
      .join('');
  }

  // Pending Invitations for this active group
  const pendingEl = document.getElementById('groupPendingInvitesList');
  if (pendingEl) {
    const pendingList = grp.pendingInvites || [];
    if (pendingList.length === 0) {
      pendingEl.innerHTML = '';
    } else {
      pendingEl.innerHTML = `
        <div style="font-size:11.5px;font-weight:700;color:var(--muted);margin-top:4px;">Đang chờ xác nhận qua Email (${pendingList.length}):</div>
        ${pendingList
          .map(
            inv => `
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:6px 10px;background:var(--surface);border:1px dashed var(--border);border-radius:9px;color:var(--muted);">
            <span>${inv.invitee_email}</span>
            <span style="font-size:11px;color:var(--amber);font-weight:600;">Chờ đồng ý</span>
          </div>
        `
          )
          .join('')}
      `;
    }
  }
}

/**
 * Interactive Drag-to-Vote Timetable Grid
 */
function renderDragToVoteGrid() {
  const grp = state.activeGroup;
  const week = state.weekMeta;
  const headEl = document.getElementById('dragVoteHead');
  const bodyEl = document.getElementById('dragVoteBody');
  if (!headEl || !bodyEl) return;

  if (!grp || !week) {
    document.getElementById('activeGroupTitle').textContent = 'Chưa có nhóm nào';
    document.getElementById('activeGroupDesc').textContent =
      'Hãy bấm "+ Tạo nhóm" ở cột bên trái hoặc đồng ý lời mời tham gia nhóm để bắt đầu kéo thả lịch rảnh.';
    headEl.innerHTML = '';
    bodyEl.innerHTML = `
      <tr>
        <td colspan="8" style="padding:36px;text-align:center;color:var(--muted);">
          Bạn chưa tham gia nhóm nào. Hãy tạo nhóm đầu tiên của bạn và gửi lời mời qua Email cho các thành viên!
        </td>
      </tr>
    `;
    updateSelectedSlotsCounter(0);
    return;
  }

  const isJoinedMember = (grp.members || []).some(
    m => (m.user_email || '').toLowerCase() === (state.currentUser?.email || '').toLowerCase()
  );

  document.getElementById('activeGroupTitle').textContent = `${grp.name} · Tuần ${week.weekKey}`;
  document.getElementById('activeGroupDesc').innerHTML = isJoinedMember && grp.invite_code
    ? `${grp.description} · <span class="pill-badge pill-sage tabular" style="cursor:pointer;" id="copyGroupInviteCodeBadge" title="Bấm để sao chép mã mời (Chỉ thành viên đã vào nhóm mới thấy)">Mã mời nhóm: ${grp.invite_code}</span>`
    : grp.description;

  document.getElementById('copyGroupInviteCodeBadge')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(grp.invite_code);
    showToast(`Đã sao chép mã mời nhóm: ${grp.invite_code}`);
  });

  headEl.innerHTML = `
    <tr>
      <th style="width:58px;">GIỜ</th>
      ${week.days
        .map(
          d => `
          <th>
            ${d.code}
            <span class="th-sub">${d.dayNum}/${d.monthNum}</span>
          </th>
        `
        )
        .join('')}
    </tr>
  `;

  // Map other members' votes for heatmap display
  const otherVotes = (grp.allVotesForWeek || []).filter(
    v => v.user_email.toLowerCase() !== (state.currentUser?.email || '').toLowerCase()
  );
  const managerVote = (grp.allVotesForWeek || []).find(
    v => v.user_email.toLowerCase() === (grp.manager_email || '').toLowerCase() || v.is_manager
  );

  let totalSelectedCells = 0;

  bodyEl.innerHTML = state.timeSlots
    .map(slot => {
      const cellsHtml = week.days
        .map(day => {
          const myDaySlots = state.mySlots[day.code] || [];
          const isMySelected = myDaySlots.includes(slot);
          if (isMySelected) totalSelectedCells++;

          // Count how many other members are free in this cell
          let othersFreeCount = 0;
          otherVotes.forEach(ov => {
            if ((ov.slots?.[day.code] || []).includes(slot)) othersFreeCount++;
          });

          const totalFreeHere = othersFreeCount + (isMySelected ? 1 : 0);
          const managerFreeHere = (managerVote?.slots?.[day.code] || []).includes(slot);

          let heatClass = '';
          if (!isMySelected && othersFreeCount > 0) {
            heatClass =
              othersFreeCount >= 3 ? 'others-full' : othersFreeCount === 2 ? 'others-2' : 'others-1';
          }

          return `
            <td class="slot-cell ${isMySelected ? 'my-selected' : ''} ${heatClass} ${managerFreeHere ? 'manager-only-indicator' : ''}"
                data-day="${day.code}"
                data-slot="${slot}"
                title="${day.code} ${slot} · ${totalFreeHere}/${grp.members?.length || 4} người rảnh${managerFreeHere ? ' (Manager rảnh)' : ''}">
              ${totalFreeHere > 0 ? `${totalFreeHere}/${grp.members?.length || 4}` : ''}
            </td>
          `;
        })
        .join('');

      return `
        <tr>
          <td class="time-label-cell">${slot}</td>
          ${cellsHtml}
        </tr>
      `;
    })
    .join('');

  updateSelectedSlotsCounter(totalSelectedCells);

  // Attach pointer / mouse drag events
  const cells = bodyEl.querySelectorAll('.slot-cell');
  cells.forEach(cell => {
    cell.addEventListener('mousedown', e => {
      e.preventDefault();
      const day = cell.dataset.day;
      const slot = cell.dataset.slot;
      const currentlySelected = (state.mySlots[day] || []).includes(slot);
      state.isDragging = true;
      state.dragPaintMode = !currentlySelected;
      toggleSlotInState(day, slot, state.dragPaintMode, cell);
    });

    cell.addEventListener('mouseenter', () => {
      if (!state.isDragging) return;
      const day = cell.dataset.day;
      const slot = cell.dataset.slot;
      toggleSlotInState(day, slot, state.dragPaintMode, cell);
    });
  });
}

window.addEventListener('mouseup', () => {
  if (state.isDragging) {
    state.isDragging = false;
    scheduleAutoSaveVotes(false);
  }
});

function toggleSlotInState(day, slot, shouldSelect, cellEl) {
  if (!Array.isArray(state.mySlots[day])) {
    state.mySlots[day] = [];
  }
  const idx = state.mySlots[day].indexOf(slot);
  if (shouldSelect && idx === -1) {
    state.mySlots[day].push(slot);
    state.mySlots[day].sort();
  } else if (!shouldSelect && idx !== -1) {
    state.mySlots[day].splice(idx, 1);
  }

  cellEl.classList.toggle('my-selected', shouldSelect);

  const allSelected = Object.values(state.mySlots).reduce((acc, arr) => acc + (arr?.length || 0), 0);
  updateSelectedSlotsCounter(allSelected);
}

function updateSelectedSlotsCounter(count) {
  const el = document.getElementById('mySelectedSlotsCounter');
  if (el) {
    const hours = (count * 0.5).toFixed(1).replace('.0', '');
    el.textContent = `Đang chọn: ${count} ô (${hours} giờ)`;
  }
}

function scheduleAutoSaveVotes(syncAllGroups = false) {
  const saveBtn = document.getElementById('saveVoteBtn');
  if (saveBtn) saveBtn.textContent = 'Đang lưu...';

  clearTimeout(state.saveDebounceTimer);
  state.saveDebounceTimer = setTimeout(async () => {
    try {
      const res = await apiFetch(`/api/groups/${state.activeGroupId}/vote`, {
        method: 'POST',
        body: JSON.stringify({
          weekKey: state.weekMeta?.weekKey,
          slots: state.mySlots,
          syncAllGroups
        })
      });
      if (saveBtn) saveBtn.textContent = 'Đã lưu tự động';
      if (syncAllGroups) showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      if (saveBtn) saveBtn.textContent = 'Lỗi lưu';
      showToast(err.message);
    }
  }, 240);
}

/**
 * Right Column: Toss-up Segmented Cards & Best Recommendation Spotlight
 */
function renderSingleGroupOverlapPanel() {
  const grp = state.activeGroup;
  const qBadge = document.getElementById('quorumBadge');
  const spotlight = document.getElementById('bestSlotSpotlight');
  const stack = document.getElementById('workspaceTossupCards');

  if (!grp || !grp.overlap) {
    if (qBadge) qBadge.textContent = '0/0';
    if (spotlight) {
      spotlight.innerHTML = `
        <div style="font-weight:700;color:var(--muted);margin-bottom:4px;">Chưa có dữ liệu nhóm</div>
        <div style="font-size:12.5px;color:var(--muted);">
          Sau khi tạo nhóm và các thành viên kéo thả lịch rảnh, hệ thống sẽ tự động xếp hạng khung giờ tốt nhất tại đây.
        </div>
      `;
    }
    if (stack) stack.innerHTML = '';
    return;
  }

  const ov = grp.overlap;
  if (qBadge) {
    qBadge.textContent = `Quorum ${ov.minQuorum}/${ov.totalMembers}`;
  }

  const best = ov.bestRecommendation;

  if (spotlight) {
    if (best && best.freeCount > 0) {
      const freeNames = (best.freeMembers || []).map(m => m.name).join(', ');
      spotlight.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <span class="pill-badge pill-sage">Đề xuất lịch rảnh nhất tuần</span>
          <span class="tabular" style="font-weight:700;color:var(--sage);font-size:15px;">${best.freeCount}/${best.totalMembers} rảnh</span>
        </div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-0.02em;margin-bottom:4px;" class="tabular">
          ${best.dayCode} (${best.dayNum}) · ${best.timeRange}
        </div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">
          Thành viên rảnh: <strong>${freeNames}</strong>
        </div>
        <button type="button" class="btn btn-sage btn-sm" id="spotlightConfirmBtn" style="width:100%;">
          Chốt khung giờ vàng này & Gửi Gmail
        </button>
      `;

      document.getElementById('spotlightConfirmBtn')?.addEventListener('click', () => {
        openConfirmModalWithSlot(best);
      });
    } else {
      spotlight.innerHTML = `
        <div style="font-weight:700;color:var(--coral);margin-bottom:4px;">Chưa tìm thấy khung giờ trùng khớp</div>
        <div style="font-size:12.5px;color:var(--muted);">
          ${ov.managerMode ? 'Manager chưa rảnh trùng với nhóm. Hãy kéo thêm ô lịch rảnh hoặc tắt thử Manager Mode.' : 'Hãy kéo thả trên bảng bên cạnh để chọn khung giờ rảnh.'}
        </div>
      `;
    }
  }

  if (stack) {
    stack.innerHTML = (ov.tossupCards || [])
      .map(card => renderTossupSegmentedCardHtml(card, true))
      .join('');

    stack.querySelectorAll('.tossup-day-card').forEach(el => {
      el.addEventListener('click', () => {
        const dayCode = el.dataset.dayCode;
        const cardObj = (ov.tossupCards || []).find(c => c.dayCode === dayCode);
        if (cardObj && cardObj.freeCount > 0) {
          openConfirmModalWithSlot(cardObj);
        } else {
          showToast(`Ngày ${dayCode} hiện chưa có khung giờ trùng. Hãy kéo thả thêm lịch rảnh trên bảng.`);
        }
      });
    });
  }
}

// ============================================================================
// 5. LỊCH MEETING (7-DAY CALENDAR BOARD OF CONFIRMED MEETINGS & GROUP OVERLAP)
// ============================================================================

function renderMultiGroupComparisonView() {
  const chipsContainer = document.getElementById('multiGroupSelectorChips');
  const bannerEl = document.getElementById('multiGroupBestBanner');
  const matrixEl = document.getElementById('multiGroupMatrixGrid');
  if (!chipsContainer || !matrixEl) return;

  if (state.groups.length === 0) {
    chipsContainer.innerHTML = '';
  } else {
    chipsContainer.innerHTML = state.groups
      .map(g => {
        const checked = state.compareGroupIds.includes(g.id);
        return `
          <button type="button" class="crew-chip ${checked ? 'active' : ''}" data-toggle-compare-group="${g.id}">
            <span>${checked ? 'Đang hiển thị:' : '+'} ${g.name}</span>
            <span class="tabular" style="opacity:0.8;">(${g.members?.length || 0} người)</span>
          </button>
        `;
      })
      .join('');

    chipsContainer.querySelectorAll('[data-toggle-compare-group]').forEach(btn => {
      btn.addEventListener('click', () => {
        const gid = btn.dataset.toggleCompareGroup;
        if (state.compareGroupIds.includes(gid)) {
          if (state.compareGroupIds.length > 1) {
            state.compareGroupIds = state.compareGroupIds.filter(id => id !== gid);
          }
        } else {
          state.compareGroupIds.push(gid);
        }
        loadDashboardData();
      });
    });
  }

  const mg = state.multiGroupOverlap;
  const best = mg?.bestMultiSlot;

  if (bannerEl) {
    if (best && best.freeCount > 0 && mg?.selectedGroups?.length > 0) {
      bannerEl.innerHTML = `
        <div style="background:var(--sage-soft);border-radius:16px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;">
          <div>
            <span class="pill-badge pill-sage" style="margin-bottom:6px;">Gợi ý khung giờ trống trên Calendar (${mg.selectedGroups.length} nhóm)</span>
            <div style="font-size:18px;font-weight:700;" class="tabular">
              ${best.dayCode} (${best.dateIso}) · ${best.timeRange} : ${best.freeCount}/${mg.totalUniqueParticipants} thành viên rảnh
            </div>
            <div style="font-size:12.5px;color:var(--ink-soft);margin-top:3px;">
              Nhóm áp dụng: <strong>${mg.selectedGroups.map(g => g.name).join(' + ')}</strong>
            </div>
          </div>
          <button type="button" class="btn btn-sage btn-sm" id="confirmMultiGroupSlotBtn">
            Chốt lên Lịch meeting
          </button>
        </div>
      `;
      document.getElementById('confirmMultiGroupSlotBtn')?.addEventListener('click', () => {
        openConfirmModalWithSlot(best);
      });
    } else {
      bannerEl.innerHTML = '';
    }
  }

  const weekDays = state.weekMeta?.days || [];
  const mgDaysMap = {};
  (mg?.days || []).forEach(d => {
    mgDaysMap[d.dayCode] = d;
  });

  // Filter confirmed meetings for selected groups (or all user meetings if no filter)
  const selectedSet = new Set(state.compareGroupIds);
  const allConfirmed = (state.confirmedMeetings || []).filter(m =>
    selectedSet.size === 0 || !m.group_id || selectedSet.has(m.group_id)
  );

  matrixEl.innerHTML = weekDays
    .map(day => {
      const dayOverlap = mgDaysMap[day.code];
      const dayMeetings = allConfirmed.filter(
        m =>
          m.date_iso === day.dateIso ||
          (m.day_code === day.code && (!m.week_key || m.week_key === state.weekMeta?.weekKey))
      );

      const hasConfirmed = dayMeetings.length > 0;

      const eventsHtml = hasConfirmed
        ? dayMeetings
            .map(
              m => `
              <div class="mcal-event-card">
                <div class="mcal-event-time">
                  <span>${m.start_time} - ${m.end_time}</span>
                  <span class="pill-badge pill-sage" style="font-size:10px;padding:2px 6px;">Đã chốt</span>
                </div>
                <div class="mcal-event-title">${m.title}</div>
                <div class="mcal-event-meta">
                  <div>Nhóm: <strong>${m.group_name}</strong></div>
                  <div>Địa điểm: ${m.location || 'Google Meet'}</div>
                </div>
                <a href="${m.googleCalendarUrl}" target="_blank" rel="noopener" class="mcal-event-link">
                  + Mở Google Calendar
                </a>
              </div>
            `
            )
            .join('')
        : `
          <div style="font-size:12px;color:var(--muted);padding:14px 6px;text-align:center;">
            Chưa có lịch họp chốt trong ngày này
          </div>
        `;

      const freeSlotHtml =
        dayOverlap && dayOverlap.freeCount > 0
          ? `
            <div class="mcal-free-slot-box good-overlap">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
                <span style="font-weight:700;color:var(--sage);">Giờ rảnh chung</span>
                <span class="tabular" style="font-weight:700;color:var(--sage);">${dayOverlap.freeCount}/${mg?.totalUniqueParticipants || 1}</span>
              </div>
              <div class="tabular" style="font-weight:600;color:var(--ink-soft);margin-bottom:6px;">
                ${dayOverlap.timeRange}
              </div>
              <button type="button" class="btn btn-ghost btn-sm" style="width:100%;padding:5px 8px;font-size:11px;" data-cal-quick-confirm="${day.code}">
                + Chốt giờ này
              </button>
            </div>
          `
          : `
            <div class="mcal-free-slot-box">
              <div style="color:var(--muted);font-weight:600;">Khung giờ rảnh</div>
              <div style="color:var(--muted);font-size:11px;margin-top:2px;">Chưa có giờ trùng liên nhóm</div>
            </div>
          `;

      return `
        <div class="mcal-day-col ${hasConfirmed ? 'has-confirmed' : ''}">
          <div class="mcal-day-header">
            <div>
              <span class="mcal-day-title">${day.code}</span>
              <span class="mcal-day-sub">${day.labelVi || ''}</span>
            </div>
            <span class="mcal-date-pill">${day.dayNum}/${day.monthNum}</span>
          </div>
          <div class="mcal-events-stack">
            ${eventsHtml}
          </div>
          ${freeSlotHtml}
        </div>
      `;
    })
    .join('');

  matrixEl.querySelectorAll('[data-cal-quick-confirm]').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.calQuickConfirm;
      const d = mgDaysMap[code];
      const dayInfo = weekDays.find(w => w.code === code);
      if (d) {
        const parts = String(d.timeRange || '19:30–21:00').split(/[–-]/);
        openConfirmModalWithSlot({
          dayCode: code,
          dateIso: d.dateIso || dayInfo?.dateIso,
          startTime: parts[0]?.trim() || '19:30',
          endTime: parts[1]?.trim() || '21:00',
          freeCount: d.freeCount,
          totalMembers: mg?.totalUniqueParticipants || 1,
          managerFree: true
        });
      }
    });
  });
}

// ============================================================================
// 6. SHARED CONFIRMED CALENDAR & GOOGLE CALENDAR / REMINDER EMAIL ACTIONS
// ============================================================================

function renderConfirmedCalendarView() {
  const grid = document.getElementById('confirmedCalendarGrid');
  if (!grid) return;

  if (state.confirmedMeetings.length === 0) {
    grid.innerHTML = `<div style="color:var(--muted);padding:24px;">Chưa có lịch họp nào được chốt.</div>`;
    return;
  }

  grid.innerHTML = state.confirmedMeetings
    .map(
      m => `
      <article class="meeting-card">
        <div>
          <div class="meeting-badge-row" style="margin-bottom:10px;">
            <span class="pill-badge pill-sage">${m.group_name}</span>
            <span class="pill-badge ${m.manager_matched ? 'pill-amber' : 'pill-coral'} tabular">
              ${m.week_key} · ${m.manager_matched ? 'Khớp Manager' : 'Số đông'}
            </span>
          </div>
          <h3 style="font-size:17px;font-weight:700;margin-bottom:6px;line-height:1.3;">${m.title}</h3>
          <div class="tabular" style="font-size:14px;font-weight:700;color:var(--sage);margin-bottom:6px;">
            ${m.day_code} (${m.date_iso}) · ${m.start_time} - ${m.end_time}
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px;">
            Địa điểm: <strong>${m.location || 'Google Meet'}</strong>
          </div>
          <div style="font-size:12px;color:var(--muted);">
            Thành viên (${(m.attendee_names || []).length}): ${(m.attendee_names || []).join(', ')}
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:12px;">
          <a href="${m.googleCalendarUrl}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">
            + Google Calendar
          </a>
          <a href="/api/meetings/${m.id}/ics" download class="btn btn-ghost btn-sm">
            Tải file .ics
          </a>
          <button type="button" class="btn btn-coral btn-sm" data-remind-meeting="${m.id}">
            Gửi mail nhắc nhở ngay
          </button>
        </div>
      </article>
    `
    )
    .join('');

  grid.querySelectorAll('[data-remind-meeting]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.remindMeeting;
      const originalText = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Đang gửi Gmail...';
        const res = await apiFetch(`/api/meetings/${id}/remind`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        showToast(res.message);
        await loadDashboardData();
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

function renderEmailLogsView() {
  // 1. Render Voting History List
  const votingList = document.getElementById('votingHistoryList');
  const votingBadge = document.getElementById('votingHistoryCountBadge');
  if (votingBadge) {
    votingBadge.textContent = `${(state.votingHistory || []).length} lượt ghi nhận`;
  }
  if (votingList) {
    if (!state.votingHistory || state.votingHistory.length === 0) {
      votingList.innerHTML = `
        <div style="padding:18px;background:var(--surface-elevated);border-radius:14px;color:var(--muted);">
          Chưa có lịch sử vote. Kéo thả các ô lịch rảnh ở tab Kéo thả để hệ thống tự động ghi nhận lần vote của bạn!
        </div>
      `;
    } else {
      votingList.innerHTML = state.votingHistory
        .map(
          item => `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 16px;background:var(--surface-elevated);border-radius:14px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
              <span class="pill-badge pill-sage">${item.action === 'vote_submitted' ? 'Đã vote' : 'Cập nhật vote'}</span>
              <strong style="font-size:14px;">${item.user_name}</strong>
              <span style="font-size:12.5px;color:var(--muted);">nhóm <strong>${item.group_name}</strong></span>
            </div>
            <div style="font-size:12px;color:var(--muted);">
              Tuần: <strong>${item.week_key}</strong> · Số khung giờ đã chọn: <strong class="tabular" style="color:var(--sage);">${item.slots_count} ô (30p/ô)</strong>
            </div>
          </div>
          <div style="font-size:12px;color:var(--muted);text-align:right;">
            <div class="tabular">${new Date(item.created_at).toLocaleString('vi-VN')}</div>
          </div>
        </div>
      `
        )
        .join('');
    }
  }

  // 2. Render Confirmed Meetings History List
  const meetingList = document.getElementById('meetingHistoryList');
  const meetingBadge = document.getElementById('meetingHistoryCountBadge');
  const allMeetingsHistory = (state.meetingHistory && state.meetingHistory.length > 0)
    ? state.meetingHistory
    : (state.confirmedMeetings || []).map(m => ({
        id: m.id,
        group_name: m.group_name,
        week_key: m.week_key,
        title: m.title,
        time: `${m.day_code} (${m.date_iso}) ${m.start_time}-${m.end_time}`,
        location: m.location,
        confirmed_by: m.confirmed_by_name,
        attendees_count: (m.attendee_names || []).length,
        created_at: m.created_at
      }));

  if (meetingBadge) {
    meetingBadge.textContent = `${allMeetingsHistory.length} cuộc họp`;
  }
  if (meetingList) {
    if (allMeetingsHistory.length === 0) {
      meetingList.innerHTML = `
        <div style="padding:18px;background:var(--surface-elevated);border-radius:14px;color:var(--muted);">
          Chưa có cuộc họp nào được chốt trong lịch sử. Bấm vào bất kỳ thẻ ngày đề xuất rảnh nhất để chốt cuộc họp!
        </div>
      `;
    } else {
      meetingList.innerHTML = allMeetingsHistory
        .map(
          item => `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:14px 16px;background:var(--surface-elevated);border-radius:14px;border-left:4px solid var(--sage);">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span class="pill-badge pill-sage">Đã chốt lịch</span>
              <strong style="font-size:14px;">${item.title}</strong>
            </div>
            <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:3px;">
              Nhóm: <strong>${item.group_name}</strong> · Tuần: <strong>${item.week_key}</strong> · Thời gian: <strong style="color:var(--sage);">${item.time}</strong>
            </div>
            <div style="font-size:12px;color:var(--muted);">
              Địa điểm: ${item.location || 'Google Meet'} · Người chốt: <strong>${item.confirmed_by}</strong> · (${item.attendees_count} người tham gia)
            </div>
          </div>
          <div style="font-size:12px;color:var(--muted);text-align:right;">
            <div class="tabular">${new Date(item.created_at).toLocaleString('vi-VN')}</div>
          </div>
        </div>
      `
        )
        .join('');
    }
  }

  // 3. Render Email Logs
  const container = document.getElementById('emailLogsContainer');
  if (!container) return;

  if (state.emailLogs.length === 0) {
    container.innerHTML = `
      <div style="padding:18px;background:var(--surface-elevated);border-radius:14px;color:var(--muted);">
        Chưa có nhật ký gửi email trong phiên này. Hãy thử bấm <strong>"Gửi mail nhắc nhở ngay"</strong> ở tab Calendar chung hoặc chốt một lịch họp mới để kiểm tra!
      </div>
    `;
    return;
  }

  container.innerHTML = state.emailLogs
    .map(
      log => `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:13px 16px;background:var(--surface-elevated);border-radius:14px;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
            <span class="pill-badge ${log.sent ? 'pill-sage' : 'pill-coral'}">${log.type.replace(/_/g, ' ')}</span>
            <strong style="font-size:13.5px;">${log.subject}</strong>
          </div>
          <div style="font-size:12px;color:var(--muted);">
            Người nhận: <strong>${log.recipient}</strong> · <span class="tabular">${new Date(log.created_at).toLocaleString('vi-VN')}</span>
          </div>
        </div>
        <span class="pill-badge ${log.sent ? 'pill-sage' : 'pill-amber'}">
          ${log.sent ? 'Đã gửi thành công' : 'Đã lưu hàng đợi'}
        </span>
      </div>
    `
    )
    .join('');
}

// ============================================================================
// 7.5. ONBOARDING TUTORIAL FOR NEW USERS
// ============================================================================

const TUTORIAL_STEPS = [
  {
    title: 'Chào mừng bạn đến với Meet up!',
    desc: 'Meet up giúp nhóm của bạn tìm ra giờ họp trùng khớp nhất mỗi tuần mà không cần hỏi qua lại từng người.',
    features: [
      { label: 'Tự động làm mới:', text: 'Bảng vote tự động reset sạch sẽ khi bước sang tuần mới.' },
      { label: 'Không lo trùng lịch:', text: 'Tự động so sánh lịch rảnh của toàn bộ thành viên theo thời gian thực.' }
    ]
  },
  {
    title: 'Kéo chuột để chọn giờ rảnh',
    desc: 'Tại tab "Kéo thả & Đối chiếu tuần", bạn chỉ cần nhấn giữ chuột và kéo qua các ô giờ bạn có thể tham gia.',
    features: [
      { label: 'Ô màu xanh lá:', text: 'Khung giờ rảnh của bạn (hệ thống tự lưu tự động ngay khi thả chuột).' },
      { label: 'Độ đậm ô:', text: 'Ô càng đậm biểu thị càng nhiều thành viên trong nhóm đang rảnh cùng khung giờ đó.' },
      { label: 'Manager Mode:', text: 'Khi bật, thuật toán sẽ lọc và chỉ gợi ý những giờ mà người phụ trách có mặt.' }
    ]
  },
  {
    title: 'Chốt lịch & Đồng bộ Calendar',
    desc: 'Khi nhóm đã chọn giờ ưng ý, người chủ trì chỉ cần 1 click để chốt lịch họp.',
    features: [
      { label: 'Lịch meeting:', text: 'Giao diện Calendar tuần hiển thị rõ ràng mọi buổi họp đã chốt.' },
      { label: 'Google Calendar:', text: 'Tự động thêm vào Google Calendar hoặc tải file .ics về điện thoại, máy tính.' },
      { label: 'Thông báo Email:', text: 'Hệ thống tự gửi thông báo và email nhắc nhở trước giờ họp.' }
    ]
  }
];

let currentTutorialStep = 0;

function checkAndShowTutorial() {
  if (!state.currentUser) return;
  const userKey = `meetup_tutorial_seen_${state.currentUser.email}`;
  const seen = localStorage.getItem(userKey);
  if (!seen) {
    currentTutorialStep = 0;
    renderTutorialStep(currentTutorialStep);
    document.getElementById('tutorialModal')?.classList.add('open');
  }
}

function renderTutorialStep(stepIdx) {
  const step = TUTORIAL_STEPS[stepIdx];
  if (!step) return;

  const badgeEl = document.getElementById('tutorialStepBadge');
  if (badgeEl) badgeEl.textContent = `Bước ${stepIdx + 1} / ${TUTORIAL_STEPS.length}`;

  const contentEl = document.getElementById('tutorialContent');
  if (contentEl) {
    const featHtml = step.features
      .map(
        f => `
        <div class="tutorial-feature-item">
          <span>•</span>
          <div><strong>${f.label}</strong> ${f.text}</div>
        </div>
      `
      )
      .join('');

    contentEl.innerHTML = `
      <div class="tutorial-step-title">${step.title}</div>
      <div class="tutorial-step-desc">${step.desc}</div>
      <div class="tutorial-feature-list">${featHtml}</div>
    `;
  }

  const prevBtn = document.getElementById('prevTutorialBtn');
  if (prevBtn) {
    prevBtn.style.visibility = stepIdx > 0 ? 'visible' : 'hidden';
  }

  const nextBtn = document.getElementById('nextTutorialBtn');
  if (nextBtn) {
    nextBtn.textContent = stepIdx === TUTORIAL_STEPS.length - 1 ? 'Bắt đầu sử dụng' : 'Tiếp theo';
  }

  const dotsContainer = document.getElementById('tutorialDots');
  if (dotsContainer) {
    dotsContainer.innerHTML = TUTORIAL_STEPS.map(
      (_, i) => `<span class="t-dot ${i === stepIdx ? 'active' : ''}"></span>`
    ).join('');
  }
}

function finishTutorial() {
  if (state.currentUser) {
    const userKey = `meetup_tutorial_seen_${state.currentUser.email}`;
    localStorage.setItem(userKey, 'true');
  }
  document.getElementById('tutorialModal')?.classList.remove('open');
}

function setupTutorialListeners() {
  document.getElementById('skipTutorialBtn')?.addEventListener('click', finishTutorial);

  document.getElementById('prevTutorialBtn')?.addEventListener('click', () => {
    if (currentTutorialStep > 0) {
      currentTutorialStep--;
      renderTutorialStep(currentTutorialStep);
    }
  });

  document.getElementById('nextTutorialBtn')?.addEventListener('click', () => {
    if (currentTutorialStep < TUTORIAL_STEPS.length - 1) {
      currentTutorialStep++;
      renderTutorialStep(currentTutorialStep);
    } else {
      finishTutorial();
    }
  });
}

function openConfirmModalWithSlot(slotCard) {
  const grp = state.activeGroup;
  if (!grp) return;

  document.getElementById('confirmGroupId').value = grp.id;
  document.getElementById('confirmWeekKey').value = state.weekMeta?.weekKey || '';
  document.getElementById('confirmManagerMatched').value = String(Boolean(slotCard?.managerFree));
  document.getElementById('confirmTitle').value = `${grp.name} : Họp định kỳ tuần ${state.weekMeta?.weekKey || ''}`;
  document.getElementById('confirmDayCode').value = slotCard?.dayCode || 'WED';
  document.getElementById('confirmStartTime').value =
    slotCard?.startTime && slotCard.startTime !== '—' ? slotCard.startTime : '19:30';
  document.getElementById('confirmEndTime').value =
    slotCard?.endTime && slotCard.endTime !== '—' ? slotCard.endTime : '21:00';
  document.getElementById('confirmDateIso').value =
    slotCard?.dateIso || state.weekMeta?.days?.[2]?.dateIso || '2026-11-11';
  document.getElementById('confirmLocation').value = grp.location || 'Phòng Studio B2 · Google Meet';
  document.getElementById('confirmNotes').value = slotCard?.freeCount
    ? `Chốt khung giờ trùng ${slotCard.freeCount}/${slotCard.totalMembers} thành viên${slotCard.managerFree ? ' (Khớp lịch Manager)' : ''}`
    : 'Chốt lịch họp định kỳ hàng tuần';

  document.getElementById('confirmMeetingModal').classList.add('open');
}

function setupWorkspaceActions() {
  // Navigation Tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      document.getElementById('viewScheduler').style.display = view === 'scheduler' ? 'block' : 'none';
      document.getElementById('viewMultigroup').style.display = view === 'multigroup' ? 'block' : 'none';
      document.getElementById('viewCalendar').style.display = view === 'calendar' ? 'block' : 'none';
      document.getElementById('viewEmails').style.display = view === 'emails' ? 'block' : 'none';
    });
  });

  // History Tab Switcher inside viewEmails
  document.getElementById('tabHistVotesBtn')?.addEventListener('click', () => {
    document.getElementById('tabHistVotesBtn').className = 'btn btn-primary btn-sm';
    document.getElementById('tabHistMeetingsBtn').className = 'btn btn-ghost btn-sm';
    document.getElementById('tabHistEmailsBtn').className = 'btn btn-ghost btn-sm';
    document.getElementById('panelHistVotes').style.display = 'block';
    document.getElementById('panelHistMeetings').style.display = 'none';
    document.getElementById('panelHistEmails').style.display = 'none';
  });

  document.getElementById('tabHistMeetingsBtn')?.addEventListener('click', () => {
    document.getElementById('tabHistVotesBtn').className = 'btn btn-ghost btn-sm';
    document.getElementById('tabHistMeetingsBtn').className = 'btn btn-primary btn-sm';
    document.getElementById('tabHistEmailsBtn').className = 'btn btn-ghost btn-sm';
    document.getElementById('panelHistVotes').style.display = 'none';
    document.getElementById('panelHistMeetings').style.display = 'block';
    document.getElementById('panelHistEmails').style.display = 'none';
  });

  document.getElementById('tabHistEmailsBtn')?.addEventListener('click', () => {
    document.getElementById('tabHistVotesBtn').className = 'btn btn-ghost btn-sm';
    document.getElementById('tabHistMeetingsBtn').className = 'btn btn-ghost btn-sm';
    document.getElementById('tabHistEmailsBtn').className = 'btn btn-primary btn-sm';
    document.getElementById('panelHistVotes').style.display = 'none';
    document.getElementById('panelHistMeetings').style.display = 'none';
    document.getElementById('panelHistEmails').style.display = 'block';
  });

  // Theme Dots & Light/Dark Toggle
  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      applyThemeAndMode(btn.dataset.setTheme, state.colorMode, true);
    });
  });

  document.getElementById('toggleColorModeBtn')?.addEventListener('click', () => {
    const nextMode = state.colorMode === 'light' ? 'dark' : 'light';
    applyThemeAndMode(state.theme, nextMode, true);
  });

  // Week Navigation (Simulates rolling into next week with automatic fresh availability)
  document.getElementById('prevWeekBtn')?.addEventListener('click', () => {
    state.weekOffset -= 1;
    loadDashboardData();
  });

  document.getElementById('nextWeekBtn')?.addEventListener('click', () => {
    state.weekOffset += 1;
    showToast('Đã chuyển sang tuần tiếp theo. Bảng vote lịch rảnh tự động làm mới cho tuần mới!');
    loadDashboardData();
  });

  document.getElementById('thisWeekBtn')?.addEventListener('click', () => {
    state.weekOffset = 0;
    loadDashboardData();
  });

  // Reset Current Week Votes
  document.getElementById('resetWeekVotesBtn')?.addEventListener('click', async () => {
    if (!state.activeGroupId) return;
    try {
      const res = await apiFetch(`/api/groups/${state.activeGroupId}/reset-week`, {
        method: 'POST',
        body: JSON.stringify({ weekKey: state.weekMeta?.weekKey, mode: 'clear_current' })
      });
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Restore Seed 4/4 Votes
  document.getElementById('restoreSeedVotesBtn')?.addEventListener('click', async () => {
    if (!state.activeGroupId) return;
    try {
      const res = await apiFetch(`/api/groups/${state.activeGroupId}/reset-week`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'restore_seed' })
      });
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Sync my availability across ALL groups
  document.getElementById('syncAllGroupsBtn')?.addEventListener('click', () => {
    scheduleAutoSaveVotes(true);
  });

  // Trigger Password Reset Email directly from Email Logs Tab
  document.getElementById('triggerSupabaseResetEmailBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const orig = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Đang gửi email...';
      const email = state.currentUser?.email || 'gameyuno123@gmail.com';
      const res = await apiFetch('/api/auth/request-reset-otp', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // Trigger Batch Reminder Emails for all confirmed meetings
  document.getElementById('triggerSupabaseRemindAllBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const orig = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Đang gửi mail nhắc nhở...';
      const res = await apiFetch('/api/meetings/remind-all', {
        method: 'POST',
        body: JSON.stringify({})
      });
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // Manager Mode Toggle
  document.getElementById('managerModeToggle')?.addEventListener('click', async () => {
    if (!state.activeGroup) return;
    const current = Boolean(state.activeGroup.overlap?.managerMode);
    const next = !current;
    state.managerModeOverride = next;
    try {
      const res = await apiFetch(`/api/groups/${state.activeGroupId}/toggle-manager-mode`, {
        method: 'POST',
        body: JSON.stringify({ enabled: next })
      });
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Multi-group Manager Mode checkbox
  document.getElementById('multiGroupManagerCheck')?.addEventListener('change', e => {
    state.multiGroupManagerMode = e.target.checked;
    loadDashboardData();
  });

  // Join Group by Invite Code
  document.getElementById('joinGroupBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('joinGroupCodeInput').value.trim();
    if (!code) {
      showToast('Vui lòng nhập mã mời nhóm.');
      return;
    }
    try {
      const res = await apiFetch('/api/groups/join', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: code })
      });
      state.activeGroupId = res.group.id;
      document.getElementById('joinGroupCodeInput').value = '';
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Modal Open / Close
  document.getElementById('openCreateGroupModalBtn')?.addEventListener('click', () => {
    document.getElementById('createGroupModal').classList.add('open');
  });

  document.getElementById('openManualConfirmModalBtn')?.addEventListener('click', () => {
    const best = state.activeGroup?.overlap?.bestRecommendation;
    openConfirmModalWithSlot(best || {});
  });

  document.getElementById('openConfirmFromCalendarTabBtn')?.addEventListener('click', () => {
    const best = state.multiGroupOverlap?.bestMultiSlot || state.activeGroup?.overlap?.bestRecommendation;
    openConfirmModalWithSlot(best || {});
  });

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeModal)?.classList.remove('open');
    });
  });

  // Invite Member by Email Form (Inside Sidebar)
  document.getElementById('inviteMemberEmailForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.activeGroupId) {
      showToast('Vui lòng chọn hoặc tạo một nhóm trước khi gửi lời mời.');
      return;
    }
    const inputEl = document.getElementById('inviteMemberEmailInput');
    const btnEl = document.getElementById('inviteMemberEmailBtn');
    const email = inputEl.value.trim();
    if (!email) return;

    try {
      btnEl.disabled = true;
      btnEl.textContent = 'Đang gửi...';
      const res = await apiFetch(`/api/groups/${state.activeGroupId}/invite`, {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      inputEl.value = '';
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = 'Mời';
    }
  });

  // Create Group Form Submit
  document.getElementById('createGroupForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('newGroupName').value.trim();
    const description = document.getElementById('newGroupDesc').value.trim();
    const location = document.getElementById('newGroupLocation').value.trim();
    const min_quorum = Number(document.getElementById('newGroupQuorum').value || 2);
    const manager_mode_default = document.getElementById('newGroupManagerMode').checked;
    const inviteEmailsRaw = document.getElementById('newGroupInviteEmails')?.value || '';

    try {
      const res = await apiFetch('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          location,
          min_quorum,
          manager_mode_default,
          invite_emails: inviteEmailsRaw
        })
      });
      document.getElementById('createGroupModal').classList.remove('open');
      document.getElementById('newGroupName').value = '';
      if (document.getElementById('newGroupInviteEmails')) {
        document.getElementById('newGroupInviteEmails').value = '';
      }
      state.activeGroupId = res.group.id;
      state.compareGroupIds.push(res.group.id);
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Confirm Meeting Form Submit
  document.getElementById('confirmMeetingForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      groupId: document.getElementById('confirmGroupId').value || state.activeGroupId,
      weekKey: document.getElementById('confirmWeekKey').value || state.weekMeta?.weekKey,
      dayCode: document.getElementById('confirmDayCode').value,
      dateIso: document.getElementById('confirmDateIso').value,
      startTime: document.getElementById('confirmStartTime').value,
      endTime: document.getElementById('confirmEndTime').value,
      title: document.getElementById('confirmTitle').value.trim(),
      location: document.getElementById('confirmLocation').value.trim(),
      notes: document.getElementById('confirmNotes').value.trim(),
      managerMatched: document.getElementById('confirmManagerMatched').value === 'true',
      sendEmail: document.getElementById('confirmSendEmailCheck').checked
    };

    try {
      const res = await apiFetch('/api/meetings/confirm', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      document.getElementById('confirmMeetingModal').classList.remove('open');
      showToast(res.message);
      await loadDashboardData();
    } catch (err) {
      showToast(err.message);
    }
  });
}

// ============================================================================
// 8. BOOTSTRAP APPLICATION
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  applyThemeAndMode(state.theme, state.colorMode, false);
  setupAuthForms();
  setupWorkspaceActions();
  setupTutorialListeners();
  await loadPublicBootstrap();

  if (state.token) {
    await enterProtectedWorkspace();
  }
});
