import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import {
  supabaseAdmin,
  getWeekMetadata,
  getStoreState,
  saveStoreState
} from './lib/supabase-store.js';

import {
  ALL_TIME_SLOTS,
  computeGroupOverlap,
  computeMultiGroupOverlap
} from './lib/overlap-engine.js';

import {
  SERVICE_ACCOUNT_EMAIL,
  sendRegisterOtpEmail,
  sendResetPasswordOtpEmail,
  sendMeetingConfirmedEmail,
  sendMeetingReminderEmail,
  sendGroupInvitationEmail,
  buildGoogleCalendarUrl
} from './lib/email-service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3005);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Active session tokens mapped in memory + persisted in Supabase store for reliability
const activeSessions = new Map();

function createSessionToken(user) {
  const token = `ts_${crypto.randomBytes(24).toString('hex')}`;
  activeSessions.set(token, {
    userId: user.id,
    email: user.email,
    createdAt: Date.now()
  });
  return token;
}

function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

/**
 * Protected Route Middleware:
 * Supports session token (`Authorization: Bearer ts_...`) OR Supabase JWT (`Authorization: Bearer eyJ...`)
 * OR fallback `x-user-email` for quick member switching in workspace demo.
 */
async function requireAuth(req, res, next) {
  try {
    const state = await getStoreState();
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const switchEmail = req.headers['x-user-email'];

    let resolvedUser = null;

    if (bearerToken.startsWith('ts_')) {
      const sess = activeSessions.get(bearerToken);
      if (sess) {
        resolvedUser = state.users.find(u => u.email.toLowerCase() === sess.email.toLowerCase());
      }
      if (!resolvedUser && Array.isArray(state.sessions)) {
        const savedSess = state.sessions.find(s => s.token === bearerToken);
        if (savedSess) {
          resolvedUser = state.users.find(u => u.email.toLowerCase() === savedSess.email.toLowerCase());
        }
      }
    } else if (bearerToken.length > 30) {
      // Verify Supabase Auth JWT
      const { data, error } = await supabaseAdmin.auth.getUser(bearerToken);
      if (!error && data?.user?.email) {
        resolvedUser = state.users.find(u => u.email.toLowerCase() === data.user.email.toLowerCase());
      }
    }

    if (!resolvedUser && switchEmail) {
      resolvedUser = state.users.find(u => u.email.toLowerCase() === String(switchEmail).toLowerCase());
    }

    if (!resolvedUser) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.'
      });
    }

    req.user = resolvedUser;
    req.storeState = state;
    next();
  } catch (err) {
    res.status(500).json({ error: 'AUTH_ERROR', message: err.message });
  }
}

function generateSixDigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function logEmailEvent(state, entry) {
  if (!Array.isArray(state.email_logs)) state.email_logs = [];
  state.email_logs.unshift({
    id: `eml-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    created_at: new Date().toISOString(),
    ...entry
  });
  if (state.email_logs.length > 50) {
    state.email_logs = state.email_logs.slice(0, 50);
  }
}

// ============================================================================
// 1. AUTHENTICATION & GMAIL OTP ENDPOINTS (Register OTP + Reset Password OTP)
// ============================================================================

/**
 * POST /api/auth/request-register-otp
 * Generates 6-digit OTP and sends registration verification email via Gmail SMTP
 */
app.post('/api/auth/request-register-otp', async (req, res) => {
  try {
    const { email, name, password, role = 'member' } = req.body || {};
    if (!email || ! email.includes('@')) {
      return res.status(400).json({ error: 'Vui lòng nhập địa chỉ Gmail hợp lệ.' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const state = await getStoreState();

    const otp = generateSixDigitOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 mins

    state.otps = (state.otps || []).filter(
      o => !(o.email.toLowerCase() === normalizedEmail && o.purpose === 'register')
    );
    state.otps.push({
      email: normalizedEmail,
      name: name || normalizedEmail.split('@')[0],
      password_hash: bcrypt.hashSync(String(password), 10),
      raw_password: String(password),
      role: role === 'manager' ? 'manager' : 'member',
      purpose: 'register',
      otp,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    });

    const mailResult = await sendRegisterOtpEmail({
      email: normalizedEmail,
      name: name || normalizedEmail.split('@')[0],
      otp
    });

    logEmailEvent(state, {
      type: 'REGISTER_OTP',
      recipient: normalizedEmail,
      subject: `[Meet up] Mã OTP đăng ký tài khoản (6 số)`,
      sent: mailResult.sent,
      messageId: mailResult.messageId || null
    });

    await saveStoreState(state);

    if (!mailResult.sent) {
      return res.status(500).json({
        error: `Không thể gửi email OTP lúc này: ${mailResult.error || 'Vui lòng kiểm tra kết nối mạng'}`
      });
    }

    res.json({
      ok: true,
      email: normalizedEmail,
      emailSent: mailResult.sent,
      message: `Đã gửi mã OTP 6 số tới hộp thư ${normalizedEmail}. Vui lòng mở email để lấy mã xác nhận.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/verify-register-otp
 * Verifies 6-digit OTP, creates user in Supabase Auth (auth.users) + store, and logs in
 */
app.post('/api/auth/verify-register-otp', async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const cleanOtp = String(otp || '').trim();

    const state = await getStoreState();
    const record = (state.otps || []).find(
      o => o.email.toLowerCase() === normalizedEmail && o.purpose === 'register'
    );

    if (!record) {
      return res.status(400).json({ error: 'Không tìm thấy yêu cầu OTP cho email này. Vui lòng gửi lại mã.' });
    }
    if (Date.now() > record.expires_at) {
      return res.status(400).json({ error: 'Mã OTP đã hết hạn (quá 10 phút). Vui lòng yêu cầu mã mới.' });
    }
    if (record.otp !== cleanOtp) {
      return res.status(400).json({ error: 'Mã OTP không chính xác. Vui lòng kiểm tra lại hộp thư email.' });
    }

    const avatarPalette = ['#3D7A5A', '#E85A4F', '#2E6B8E', '#C88A2E', '#7A5486'];
    const avatarColor = avatarPalette[state.users.length % avatarPalette.length];

    let user = state.users.find(u => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      user = {
        id: `usr-${Date.now().toString(36)}`,
        email: normalizedEmail,
        name: record.name,
        role: record.role || 'member',
        avatar_color: avatarColor,
        theme: 'warm-paper',
        color_mode: 'light',
        password_hash: record.password_hash,
        created_at: new Date().toISOString()
      };
      state.users.push(user);
    } else {
      user.name = record.name || user.name;
      user.password_hash = record.password_hash;
      user.role = record.role || user.role;
    }

    // Sync with Supabase Auth Admin API (auth.users)
    try {
      await supabaseAdmin.auth.admin.createUser({
        email: user.email,
        password: record.raw_password,
        email_confirm: true,
        user_metadata: {
          name: user.name,
          avatar_color: user.avatar_color,
          theme: user.theme,
          color_mode: user.color_mode
        },
        app_metadata: {
          role: user.role
        }
      });
    } catch (_) {}

    // Remove used OTP
    state.otps = state.otps.filter(o => !(o.email.toLowerCase() === normalizedEmail && o.purpose === 'register'));

    const token = createSessionToken(user);
    if (!Array.isArray(state.sessions)) state.sessions = [];
    state.sessions.push({ token, email: user.email, created_at: new Date().toISOString() });

    await saveStoreState(state);

    res.json({
      ok: true,
      token,
      user: sanitizeUser(user),
      message: 'Xác thực OTP thành công! Tài khoản của bạn đã sẵn sàng.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Standard Email + Password login
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const state = await getStoreState();

    const user = state.users.find(u => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản với email này. Vui lòng chuyển sang tab Đăng ký (OTP) để tạo tài khoản.' });
    }

    const valid = bcrypt.compareSync(String(password || ''), user.password_hash || '');
    if (!valid) {
      return res.status(401).json({ error: 'Mật khẩu không đúng. Bạn có thể bấm "Quên mật khẩu" để nhận mã OTP qua email.' });
    }

    const token = createSessionToken(user);
    if (!Array.isArray(state.sessions)) state.sessions = [];
    state.sessions = state.sessions.filter(s => s.email.toLowerCase() !== user.email.toLowerCase());
    state.sessions.push({ token, email: user.email, created_at: new Date().toISOString() });
    await saveStoreState(state);

    res.json({
      ok: true,
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/request-reset-otp
 * Sends Password Reset OTP email via Gmail SMTP
 */
app.post('/api/auth/request-reset-otp', async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return res.status(400).json({ error: 'Vui lòng nhập email hợp lệ để nhận mã OTP đặt lại mật khẩu.' });
    }

    const state = await getStoreState();
    const user = state.users.find(u => u.email.toLowerCase() === normalizedEmail);
    const displayName = user ? user.name : normalizedEmail.split('@')[0];

    const otp = generateSixDigitOtp();
    let supabaseEmailOtp = null;
    let supabaseRecoveryLink = null;
    let supabaseHashedToken = null;

    // Generate official Supabase Auth Recovery Link & OTP via Admin API
    try {
      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: normalizedEmail,
        options: {
          redirectTo: `http://localhost:${PORT}/?reset=supabase`
        }
      });
      if (!linkErr && linkData?.properties) {
        supabaseEmailOtp = linkData.properties.email_otp || null;
        supabaseRecoveryLink = linkData.properties.action_link || null;
        supabaseHashedToken = linkData.properties.hashed_token || null;
      }
    } catch (_) {}

    state.otps = (state.otps || []).filter(
      o => !(o.email.toLowerCase() === normalizedEmail && o.purpose === 'reset')
    );
    state.otps.push({
      email: normalizedEmail,
      name: displayName,
      purpose: 'reset',
      otp,
      supabase_email_otp: supabaseEmailOtp,
      supabase_recovery_link: supabaseRecoveryLink,
      supabase_hashed_token: supabaseHashedToken,
      service_account: SERVICE_ACCOUNT_EMAIL,
      expires_at: Date.now() + 10 * 60 * 1000,
      created_at: new Date().toISOString()
    });

    const mailResult = await sendResetPasswordOtpEmail({
      email: normalizedEmail,
      name: displayName,
      otp,
      supabaseEmailOtp,
      supabaseRecoveryLink
    });

    logEmailEvent(state, {
      type: 'RESET_PASSWORD_OTP',
      recipient: normalizedEmail,
      serviceAccount: SERVICE_ACCOUNT_EMAIL,
      subject: `[Meet up] Mã OTP đặt lại mật khẩu (6 số)`,
      sent: mailResult.sent,
      messageId: mailResult.messageId || null
    });

    await saveStoreState(state);

    if (!mailResult.sent) {
      return res.status(500).json({
        error: `Không thể gửi email khôi phục lúc này: ${mailResult.error || 'Vui lòng thử lại'}`
      });
    }

    res.json({
      ok: true,
      email: normalizedEmail,
      emailSent: mailResult.sent,
      message: `Đã gửi mã OTP 6 số đặt lại mật khẩu tới hộp thư ${normalizedEmail}. Vui lòng kiểm tra email.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/confirm-reset-password
 * Verifies Reset OTP and updates password in Supabase Auth + store
 */
app.post('/api/auth/confirm-reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const cleanOtp = String(otp || '').trim();

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có từ 6 ký tự trở lên.' });
    }

    const state = await getStoreState();
    const record = (state.otps || []).find(
      o => o.email.toLowerCase() === normalizedEmail && o.purpose === 'reset'
    );

    if (!record) {
      return res.status(400).json({ error: 'Không tìm thấy yêu cầu đặt lại mật khẩu. Vui lòng gửi lại OTP.' });
    }
    if (Date.now() > record.expires_at) {
      return res.status(400).json({ error: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.' });
    }
    const matchesOtp =
      record.otp === cleanOtp ||
      (record.supabase_email_otp && record.supabase_email_otp === cleanOtp);
    if (!matchesOtp) {
      return res.status(400).json({ error: 'Mã OTP không chính xác.' });
    }

    let user = state.users.find(u => u.email.toLowerCase() === normalizedEmail);
    const newHash = bcrypt.hashSync(String(newPassword), 10);

    if (!user) {
      user = {
        id: `usr-${Date.now().toString(36)}`,
        email: normalizedEmail,
        name: normalizedEmail.split('@')[0],
        role: 'member',
        avatar_color: '#3D7A5A',
        theme: 'warm-paper',
        color_mode: 'light',
        password_hash: newHash,
        created_at: new Date().toISOString()
      };
      state.users.push(user);
    } else {
      user.password_hash = newHash;
    }

    // Update password in Supabase Auth Admin if user exists there
    try {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 100 });
      const sbUser = (list?.users || []).find(u => (u.email || '').toLowerCase() === normalizedEmail);
      if (sbUser) {
        await supabaseAdmin.auth.admin.updateUserById(sbUser.id, {
          password: String(newPassword)
        });
      }
    } catch (_) {}

    state.otps = state.otps.filter(o => !(o.email.toLowerCase() === normalizedEmail && o.purpose === 'reset'));

    const token = createSessionToken(user);
    await saveStoreState(state);

    res.json({
      ok: true,
      token,
      user: sanitizeUser(user),
      message: 'Đặt lại mật khẩu thành công! Bạn đã được đăng nhập tự động.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me (Protected Route)
 */
app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({
    ok: true,
    user: sanitizeUser(req.user),
    allUsers: req.storeState.users.map(sanitizeUser)
  });
});

/**
 * PATCH /api/auth/preferences (Protected Route)
 * Persist user theme & light/dark mode to Supabase
 */
app.patch('/api/auth/preferences', requireAuth, async (req, res) => {
  try {
    const { theme, color_mode, name } = req.body || {};
    const state = req.storeState;
    const user = state.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (theme) user.theme = theme;
    if (color_mode) user.color_mode = color_mode;
    if (name) user.name = name;

    await saveStoreState(state);
    res.json({ ok: true, user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/public/bootstrap
 * Public endpoint returning current week metadata
 */
app.get('/api/public/bootstrap', async (req, res) => {
  try {
    const weekMeta = getWeekMetadata(0);
    res.json({
      ok: true,
      weekMeta
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 2. PROTECTED SCHEDULER, GROUPS, INVITATIONS, OVERLAP & WEEKLY AUTO-RESET
// ============================================================================

/**
 * GET /api/dashboard (Protected)
 * Returns complete workspace state scoped to the logged-in user's groups and invitations
 */
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const state = req.storeState;
    if (!Array.isArray(state.group_invitations)) state.group_invitations = [];

    const userEmailLower = req.user.email.toLowerCase();
    const weekOffset = Number(req.query.weekOffset || 0);
    const weekMeta = getWeekMetadata(weekOffset);

    // Filter groups to ONLY groups where the current user is an active member
    const myGroupIds = new Set(
      state.group_members
        .filter(m => m.user_email.toLowerCase() === userEmailLower)
        .map(m => m.group_id)
    );
    const myGroups = state.groups.filter(g => myGroupIds.has(g.id));

    const activeGroupId =
      req.query.groupId && myGroupIds.has(req.query.groupId)
        ? req.query.groupId
        : myGroups[0]?.id || null;

    const managerModeParam = req.query.managerMode;
    const compareGroupIds = req.query.compareGroups
      ? String(req.query.compareGroups)
          .split(',')
          .filter(id => myGroupIds.has(id))
      : myGroups.map(g => g.id);

    // Compute per-group summaries & overlaps for user's groups
    const groupReports = myGroups.map(grp => {
      const members = state.group_members.filter(m => m.group_id === grp.id);
      const pendingGroupInvites = state.group_invitations.filter(
        inv => inv.group_id === grp.id && inv.status === 'pending'
      );
      const overrideMgr =
        grp.id === activeGroupId && managerModeParam !== undefined
          ? managerModeParam === 'true'
          : grp.manager_mode_default;

      const overlap = computeGroupOverlap({
        group: grp,
        members,
        votes: state.availability_votes,
        weekMeta,
        managerModeOverride: overrideMgr
      });

      const myVote = state.availability_votes.find(
        v =>
          v.group_id === grp.id &&
          v.week_key === weekMeta.weekKey &&
          v.user_email.toLowerCase() === userEmailLower
      );

      const allVotesForWeek = state.availability_votes.filter(
        v => v.group_id === grp.id && v.week_key === weekMeta.weekKey
      );

      return {
        ...grp,
        members,
        pendingInvites: pendingGroupInvites,
        mySlots: myVote?.slots || {},
        allVotesForWeek,
        overlap
      };
    });

    const activeGroupReport = groupReports.find(g => g.id === activeGroupId) || groupReports[0] || null;

    // Multi-group cross-comparison
    const selectedGroupsForCompare = myGroups.filter(g => compareGroupIds.includes(g.id));
    const multiGroupManagerMode =
      req.query.multiManagerMode !== undefined
        ? req.query.multiManagerMode === 'true'
        : activeGroupReport?.overlap?.managerMode || false;

    const multiGroupOverlap = computeMultiGroupOverlap({
      groups: selectedGroupsForCompare,
      allMembers: state.group_members,
      allVotes: state.availability_votes,
      weekMeta,
      managerMode: multiGroupManagerMode,
      managerEmail: activeGroupReport?.manager_email || req.user.email
    });

    // Pending invitations sent TO this user
    const myPendingInvitations = state.group_invitations.filter(
      inv => inv.invitee_email.toLowerCase() === userEmailLower && inv.status === 'pending'
    );

    // Confirmed meetings belonging to user's groups
    const myConfirmedMeetings = (state.confirmed_meetings || [])
      .filter(
        m =>
          myGroupIds.has(m.group_id) ||
          (m.attendee_emails || []).some(e => e.toLowerCase() === userEmailLower)
      )
      .map(m => ({
        ...m,
        googleCalendarUrl: buildGoogleCalendarUrl(m)
      }));

    // Voting & meeting history scoped to user's groups
    const myVotingHistory = (state.voting_history || [])
      .filter(vh => myGroupIds.has(vh.group_id) || vh.user_email.toLowerCase() === userEmailLower)
      .slice(0, 40);

    const myMeetingHistory = (state.meeting_history || [])
      .filter(mh => myGroupIds.has(mh.group_id) || (mh.confirmed_by_email || '').toLowerCase() === userEmailLower)
      .slice(0, 40);

    const myEmailLogs = (state.email_logs || [])
      .filter(el => (el.recipient || '').toLowerCase().includes(userEmailLower))
      .slice(0, 20);

    res.json({
      ok: true,
      currentUser: sanitizeUser(req.user),
      weekMeta,
      timeSlots: ALL_TIME_SLOTS,
      groups: groupReports,
      activeGroup: activeGroupReport,
      pendingInvitations: myPendingInvitations,
      multiGroupOverlap,
      confirmedMeetings: myConfirmedMeetings,
      votingHistory: myVotingHistory,
      meetingHistory: myMeetingHistory,
      emailLogs: myEmailLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups (Protected)
 * Create a new recurring meeting group and optionally send email invitations
 */
app.post('/api/groups', requireAuth, async (req, res) => {
  try {
    const {
      name,
      description,
      category = 'Weekly Crew',
      location = 'Google Meet',
      min_quorum = 2,
      duration_minutes = 90,
      manager_mode_default = true,
      invite_emails = []
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập tên nhóm / cuộc họp định kỳ.' });
    }

    const state = req.storeState;
    if (!Array.isArray(state.group_invitations)) state.group_invitations = [];

    const weekMeta = getWeekMetadata(0);
    const groupId = `grp-${Date.now().toString(36)}`;
    const inviteCode = `${String(name).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5) || 'MEET'}-${Math.floor(100 + Math.random() * 900)}`;

    const newGroup = {
      id: groupId,
      name: String(name).trim(),
      description: String(description || 'Nhóm họp định kỳ hàng tuần, tự động làm mới lịch rảnh khi sang tuần mới.').trim(),
      category,
      location: String(location || 'Google Meet').trim(),
      invite_code: inviteCode,
      min_quorum: Number(min_quorum) || 2,
      duration_minutes: Number(duration_minutes) || 90,
      manager_email: req.user.email,
      manager_mode_default: Boolean(manager_mode_default),
      auto_reset_weekly: true,
      active_week_key: weekMeta.weekKey,
      created_at: new Date().toISOString()
    };

    state.groups.push(newGroup);

    // Only the creator is added immediately as Manager. Invited emails receive an invitation and must accept first!
    state.group_members.push({
      group_id: groupId,
      user_email: req.user.email,
      user_name: req.user.name,
      role: 'manager',
      avatar_color: req.user.avatar_color || '#3D7A5A'
    });

    const cleanInviteEmails = Array.from(
      new Set(
        (Array.isArray(invite_emails) ? invite_emails : String(invite_emails || '').split(/[,;\s]+/))
          .map(e => String(e).trim().toLowerCase())
          .filter(e => e.includes('@') && e !== req.user.email.toLowerCase())
      )
    );

    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    let sentInviteCount = 0;

    for (const targetEmail of cleanInviteEmails) {
      const inviteToken = `inv_${crypto.randomBytes(18).toString('hex')}`;
      const inviteObj = {
        id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        token: inviteToken,
        group_id: groupId,
        group_name: newGroup.name,
        group_description: newGroup.description,
        inviter_email: req.user.email,
        inviter_name: req.user.name,
        invitee_email: targetEmail,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      state.group_invitations.unshift(inviteObj);

      const mailRes = await sendGroupInvitationEmail({
        recipientEmail: targetEmail,
        inviterName: req.user.name,
        inviterEmail: req.user.email,
        groupName: newGroup.name,
        groupDescription: newGroup.description,
        inviteToken,
        appBaseUrl
      });
      if (mailRes.sent) sentInviteCount++;

      logEmailEvent(state, {
        type: 'GROUP_INVITE',
        recipient: targetEmail,
        subject: `[Meet up] ${req.user.name} mời bạn tham gia nhóm "${newGroup.name}"`,
        sent: mailRes.sent,
        messageId: mailRes.messageId || null
      });
    }

    await saveStoreState(state);
    res.json({
      ok: true,
      group: newGroup,
      sentInviteCount,
      message:
        sentInviteCount > 0
          ? `Đã tạo nhóm "${newGroup.name}" và gửi ${sentInviteCount} lời mời qua email. Khi họ bấm Đồng ý sẽ được thêm vào nhóm.`
          : `Đã tạo nhóm "${newGroup.name}" thành công!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups/:groupId/invite (Protected)
 * Send email invitation(s) to join a group. Invitee is only added after accepting.
 */
app.post('/api/groups/:groupId/invite', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { email } = req.body || {};
    const state = req.storeState;
    if (!Array.isArray(state.group_invitations)) state.group_invitations = [];

    const grp = state.groups.find(g => g.id === groupId);
    if (!grp) {
      return res.status(404).json({ error: 'Không tìm thấy nhóm này.' });
    }

    // Parse one or multiple comma-separated emails
    const emailList = Array.from(
      new Set(
        String(email || '')
          .split(/[,;\s]+/)
          .map(e => e.trim().toLowerCase())
          .filter(e => e.includes('@'))
      )
    );

    if (emailList.length === 0) {
      return res.status(400).json({ error: 'Vui lòng nhập ít nhất một địa chỉ email hợp lệ để mời.' });
    }

    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    const invitedList = [];
    const skippedAlreadyMember = [];

    for (const targetEmail of emailList) {
      const isAlreadyMember = state.group_members.some(
        m => m.group_id === groupId && m.user_email.toLowerCase() === targetEmail
      );
      if (isAlreadyMember) {
        skippedAlreadyMember.push(targetEmail);
        continue;
      }

      // Remove existing pending invite for same group + email so we issue a fresh one
      state.group_invitations = state.group_invitations.filter(
        inv =>
          !(
            inv.group_id === groupId &&
            inv.invitee_email.toLowerCase() === targetEmail &&
            inv.status === 'pending'
          )
      );

      const inviteToken = `inv_${crypto.randomBytes(18).toString('hex')}`;
      const inviteObj = {
        id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        token: inviteToken,
        group_id: groupId,
        group_name: grp.name,
        group_description: grp.description,
        inviter_email: req.user.email,
        inviter_name: req.user.name,
        invitee_email: targetEmail,
        status: 'pending',
        created_at: new Date().toISOString()
      };

      state.group_invitations.unshift(inviteObj);

      const mailRes = await sendGroupInvitationEmail({
        recipientEmail: targetEmail,
        inviterName: req.user.name,
        inviterEmail: req.user.email,
        groupName: grp.name,
        groupDescription: grp.description,
        inviteToken,
        appBaseUrl
      });

      logEmailEvent(state, {
        type: 'GROUP_INVITE',
        recipient: targetEmail,
        subject: `[Meet up] ${req.user.name} mời bạn tham gia nhóm "${grp.name}"`,
        sent: mailRes.sent,
        messageId: mailRes.messageId || null
      });

      invitedList.push({ email: targetEmail, sent: mailRes.sent });
    }

    await saveStoreState(state);

    if (invitedList.length === 0 && skippedAlreadyMember.length > 0) {
      return res.status(400).json({
        error: `${skippedAlreadyMember.join(', ')} đã là thành viên trong nhóm rồi.`
      });
    }

    res.json({
      ok: true,
      invited: invitedList,
      message: `Đã gửi email mời tham gia nhóm "${grp.name}" tới ${invitedList.map(i => i.email).join(', ')}. Khi họ đồng ý, họ sẽ được thêm vào nhóm!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invitations/:inviteId/respond (Protected)
 * Accept or decline an invitation from inside the web dashboard
 */
app.post('/api/invitations/:inviteId/respond', requireAuth, async (req, res) => {
  try {
    const { inviteId } = req.params;
    const { action = 'accept' } = req.body || {};
    const state = req.storeState;
    if (!Array.isArray(state.group_invitations)) state.group_invitations = [];

    const inv = state.group_invitations.find(
      i =>
        (i.id === inviteId || i.token === inviteId) &&
        i.invitee_email.toLowerCase() === req.user.email.toLowerCase()
    );

    if (!inv) {
      return res.status(404).json({ error: 'Không tìm thấy lời mời này.' });
    }
    if (inv.status !== 'pending') {
      return res.status(400).json({ error: 'Lời mời này đã được phản hồi trước đó.' });
    }

    if (action === 'decline') {
      inv.status = 'declined';
      inv.responded_at = new Date().toISOString();
      await saveStoreState(state);
      return res.json({
        ok: true,
        status: 'declined',
        message: `Đã từ chối lời mời vào nhóm "${inv.group_name}".`
      });
    }

    inv.status = 'accepted';
    inv.responded_at = new Date().toISOString();

    const alreadyMember = state.group_members.some(
      m => m.group_id === inv.group_id && m.user_email.toLowerCase() === req.user.email.toLowerCase()
    );
    if (!alreadyMember) {
      state.group_members.push({
        group_id: inv.group_id,
        user_email: req.user.email,
        user_name: req.user.name,
        role: 'member',
        avatar_color: req.user.avatar_color || '#2E6B8E'
      });
    }

    await saveStoreState(state);
    res.json({
      ok: true,
      status: 'accepted',
      groupId: inv.group_id,
      message: `Bạn đã đồng ý tham gia nhóm "${inv.group_name}"! Hãy kéo thả lịch rảnh của bạn.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invitations/respond
 * Direct 1-click Accept/Decline link from the invitation email
 */
app.get('/api/invitations/respond', async (req, res) => {
  try {
    const { token, action = 'accept' } = req.query || {};
    const state = await getStoreState();
    if (!Array.isArray(state.group_invitations)) state.group_invitations = [];

    const inv = state.group_invitations.find(i => i.token === token);
    if (!inv) {
      return res.status(404).send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Meet up</title></head><body style="font-family:'Be Vietnam Pro',sans-serif;background:#FBF8F0;color:#1F1B16;padding:48px;text-align:center;"><h2>Liên kết lời mời không tồn tại hoặc đã hết hạn</h2><p><a href="/" style="color:#E85A4F;font-weight:700;">Quay về trang chủ Meet up</a></p></body></html>`);
    }

    const inviteeEmail = inv.invitee_email.toLowerCase();
    const existingUser = state.users.find(u => u.email.toLowerCase() === inviteeEmail);

    if (action === 'decline') {
      inv.status = 'declined';
      inv.responded_at = new Date().toISOString();
      await saveStoreState(state);
      return res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Đã từ chối lời mời · Meet up</title></head><body style="font-family:'Be Vietnam Pro',sans-serif;background:#FBF8F0;color:#1F1B16;padding:48px;text-align:center;"><div style="max-width:460px;margin:0 auto;background:#F5F1E8;border:2px solid #1F1B16;border-radius:18px;padding:32px;"><h2 style="margin-top:0;">Đã từ chối lời mời</h2><p>Bạn đã từ chối tham gia nhóm <strong>${inv.group_name}</strong>.</p><a href="/" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1F1B16;color:#FBF8F0;text-decoration:none;border-radius:999px;font-weight:700;">Mở Meet up</a></div></body></html>`);
    }

    // Accept action
    inv.status = 'accepted';
    inv.responded_at = new Date().toISOString();

    const alreadyMember = state.group_members.some(
      m => m.group_id === inv.group_id && m.user_email.toLowerCase() === inviteeEmail
    );
    if (!alreadyMember) {
      state.group_members.push({
        group_id: inv.group_id,
        user_email: existingUser ? existingUser.email : inviteeEmail,
        user_name: existingUser ? existingUser.name : inviteeEmail.split('@')[0],
        role: 'member',
        avatar_color: existingUser ? existingUser.avatar_color : '#2E6B8E'
      });
    }

    await saveStoreState(state);

    return res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Đã tham gia nhóm · Meet up</title><link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@500;700;800&display=swap" rel="stylesheet"></head><body style="font-family:'Be Vietnam Pro',sans-serif;background:#FBF8F0;color:#1F1B16;padding:48px 16px;text-align:center;"><div style="max-width:480px;margin:0 auto;background:#F5F1E8;border:2px solid #1F1B16;border-radius:18px;padding:32px;"><div style="display:inline-block;padding:6px 14px;background:#3D7A5A;color:#FBF8F0;border-radius:999px;font-size:12px;font-weight:700;margin-bottom:12px;">Đã xác nhận đồng ý</div><h2 style="margin:0 0 10px;font-size:22px;">Chào mừng bạn vào nhóm "${inv.group_name}"!</h2><p style="color:#6E665B;font-size:14px;line-height:1.5;margin-bottom:24px;">Bạn đã chấp nhận lời mời của <strong>${inv.inviter_name}</strong>. Tài khoản <strong>${inviteeEmail}</strong> đã được thêm vào nhóm.</p><a href="/?invited_email=${encodeURIComponent(inviteeEmail)}" style="display:inline-block;padding:13px 28px;background:#3D7A5A;color:#FBF8F0;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px;">Vào bảng kéo thả lịch rảnh ngay</a></div></body></html>`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * POST /api/groups/join (Protected)
 * Join an existing group by invite_code
 */
app.post('/api/groups/join', requireAuth, async (req, res) => {
  try {
    const { inviteCode } = req.body || {};
    const cleanCode = String(inviteCode || '').trim().toUpperCase();
    const state = req.storeState;

    const grp = state.groups.find(g => g.invite_code.toUpperCase() === cleanCode);
    if (!grp) {
      return res.status(404).json({ error: 'Không tìm thấy nhóm với mã mời này.' });
    }

    const exists = state.group_members.some(
      m => m.group_id === grp.id && m.user_email.toLowerCase() === req.user.email.toLowerCase()
    );
    if (!exists) {
      state.group_members.push({
        group_id: grp.id,
        user_email: req.user.email,
        user_name: req.user.name,
        role: req.user.role === 'manager' ? 'manager' : 'member',
        avatar_color: req.user.avatar_color || '#3D7A5A'
      });
      await saveStoreState(state);
    }

    res.json({
      ok: true,
      group: grp,
      message: `Đã tham gia nhóm "${grp.name}" thành công!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups/:groupId/vote (Protected)
 * Save drag-to-vote availability slots for the current user (or specified member) in a given week.
 * Also supports `syncAllGroups: true` to sync the user's free schedule across ALL groups they belong to!
 */
app.post('/api/groups/:groupId/vote', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { weekKey, slots, syncAllGroups = false, targetUserEmail } = req.body || {};
    const state = req.storeState;

    const effectiveWeekKey = weekKey || getWeekMetadata(0).weekKey;
    const voterEmail = targetUserEmail || req.user.email;
    const voterUser =
      state.users.find(u => u.email.toLowerCase() === voterEmail.toLowerCase()) || req.user;

    const targetGroupIds = syncAllGroups
      ? state.groups
          .filter(g =>
            state.group_members.some(
              gm => gm.group_id === g.id && gm.user_email.toLowerCase() === voterEmail.toLowerCase()
            )
          )
          .map(g => g.id)
      : [groupId];

    if (!targetGroupIds.includes(groupId)) targetGroupIds.push(groupId);

    if (!state.voting_history) state.voting_history = [];

    for (const gid of targetGroupIds) {
      const grp = state.groups.find(g => g.id === gid);
      if (!grp) continue;

      // Ensure voter is a member of the group
      const isMember = state.group_members.some(
        m => m.group_id === gid && m.user_email.toLowerCase() === voterEmail.toLowerCase()
      );
      if (!isMember) {
        state.group_members.push({
          group_id: gid,
          user_email: voterUser.email,
          user_name: voterUser.name,
          role: voterUser.role || 'member',
          avatar_color: voterUser.avatar_color || '#3D7A5A'
        });
      }

      const existingIdx = state.availability_votes.findIndex(
        v =>
          v.group_id === gid &&
          v.week_key === effectiveWeekKey &&
          v.user_email.toLowerCase() === voterEmail.toLowerCase()
      );

      const votePayload = {
        group_id: gid,
        week_key: effectiveWeekKey,
        user_email: voterUser.email,
        user_name: voterUser.name,
        is_manager:
          grp.manager_email.toLowerCase() === voterUser.email.toLowerCase() ||
          voterUser.role === 'manager',
        slots: slots || {},
        updated_at: new Date().toISOString()
      };

      if (existingIdx >= 0) {
        state.availability_votes[existingIdx] = votePayload;
      } else {
        state.availability_votes.push(votePayload);
      }

      // Record full audit history for every vote submission / update
      const totalSlots = Object.values(slots || {}).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
      state.voting_history.unshift({
        id: `vhist-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        group_id: gid,
        group_name: grp.name,
        week_key: effectiveWeekKey,
        user_email: voterUser.email,
        user_name: voterUser.name,
        slots_count: totalSlots,
        action: existingIdx >= 0 ? 'vote_updated' : 'vote_submitted',
        created_at: new Date().toISOString()
      });
    }

    // Keep history manageable
    if (state.voting_history.length > 200) {
      state.voting_history = state.voting_history.slice(0, 200);
    }

    await saveStoreState(state);

    res.json({
      ok: true,
      syncedGroupsCount: targetGroupIds.length,
      message: syncAllGroups
        ? `Đã lưu & đồng bộ lịch rảnh của ${voterUser.name} sang toàn bộ ${targetGroupIds.length} nhóm trong tuần ${effectiveWeekKey}!`
        : `Đã cập nhật lịch rảnh của ${voterUser.name} cho tuần ${effectiveWeekKey}.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups/:groupId/toggle-manager-mode (Protected)
 * Persist Manager Mode preference on a group
 */
app.post('/api/groups/:groupId/toggle-manager-mode', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { enabled } = req.body || {};
    const state = req.storeState;
    const grp = state.groups.find(g => g.id === groupId);
    if (!grp) return res.status(404).json({ error: 'Không tìm thấy nhóm.' });

    grp.manager_mode_default = typeof enabled === 'boolean' ? enabled : !grp.manager_mode_default;
    await saveStoreState(state);

    res.json({
      ok: true,
      manager_mode_default: grp.manager_mode_default,
      message: grp.manager_mode_default
        ? 'Đã BẬT Manager Mode: Hệ thống chỉ đề xuất các khung giờ khớp với lịch rảnh của Manager.'
        : 'Đã TẮT Manager Mode: Hệ thống đề xuất linh hoạt theo độ trùng cao nhất của toàn nhóm.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups/:groupId/reset-week (Protected)
 * Resets votes for a given week (or simulates weekly rollover) while keeping confirmed meetings intact
 */
app.post('/api/groups/:groupId/reset-week', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { weekKey } = req.body || {};
    const state = req.storeState;
    const effectiveWeek = weekKey || getWeekMetadata(0).weekKey;

    // Clear votes for this group & week (simulating new week fresh slate)
    state.availability_votes = state.availability_votes.filter(
      v => !(v.group_id === groupId && v.week_key === effectiveWeek)
    );

    const grp = state.groups.find(g => g.id === groupId);
    if (grp) {
      grp.last_reset_at = new Date().toISOString();
    }

    await saveStoreState(state);

    res.json({
      ok: true,
      weekKey: effectiveWeek,
      message: `Đã làm mới bảng vote lịch rảnh của nhóm cho tuần ${effectiveWeek}. Các cuộc họp đã chốt trên Calendar chung vẫn được giữ nguyên.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 3. CONFIRMED MEETINGS, SHARED CALENDAR, GOOGLE CALENDAR & EMAIL REMINDERS
// ============================================================================

/**
 * POST /api/meetings/confirm (Protected)
 * Locks in a meeting slot, adds it to the shared calendar, and automatically sends confirmation email
 */
app.post('/api/meetings/confirm', requireAuth, async (req, res) => {
  try {
    const {
      groupId,
      weekKey,
      dayCode,
      dateIso,
      startTime,
      endTime,
      title,
      location,
      notes,
      managerMatched = true,
      sendEmail = true
    } = req.body || {};

    const state = req.storeState;
    const grp = state.groups.find(g => g.id === groupId) || state.groups[0];
    if (!grp) return res.status(404).json({ error: 'Không tìm thấy nhóm.' });

    const members = state.group_members.filter(m => m.group_id === grp.id);
    const attendeeEmails = members.map(m => m.user_email);
    const attendeeNames = members.map(m => m.user_name);

    const newMeeting = {
      id: `mtg-${Date.now().toString(36)}`,
      group_id: grp.id,
      group_name: grp.name,
      week_key: weekKey || getWeekMetadata(0).weekKey,
      day_code: dayCode || 'WED',
      date_iso: dateIso || getWeekMetadata(0).days[2].dateIso,
      start_time: startTime || '19:30',
      end_time: endTime || '21:00',
      location: location || grp.location || 'Google Meet',
      title: title || `${grp.name} — Họp tuần ${weekKey || ''}`.trim(),
      notes: notes || `Chốt từ bảng đề xuất lịch rảnh tốt nhất (${attendeeNames.length} thành viên)`,
      confirmed_by_email: req.user.email,
      confirmed_by_name: req.user.name,
      manager_matched: Boolean(managerMatched),
      attendee_emails: attendeeEmails,
      attendee_names: attendeeNames,
      confirmation_email_sent: false,
      reminder_email_sent: false,
      created_at: new Date().toISOString()
    };

    const googleCalendarUrl = buildGoogleCalendarUrl(newMeeting);

    let emailResult = { sent: false };
    if (sendEmail) {
      // Always include the service account / active user so the user receives the real email immediately
      const targetRecipients = Array.from(
        new Set([process.env.EMAIL_USER || 'gameyuno123@gmail.com', req.user.email])
      );
      emailResult = await sendMeetingConfirmedEmail({
        meeting: newMeeting,
        recipients: targetRecipients,
        googleCalendarUrl
      });
      newMeeting.confirmation_email_sent = emailResult.sent;

      logEmailEvent(state, {
        type: 'MEETING_CONFIRMED',
        recipient: targetRecipients.join(', '),
        serviceAccount: SERVICE_ACCOUNT_EMAIL,
        subject: `[Meet up] Đã chốt lịch: ${newMeeting.title} (${newMeeting.day_code} ${newMeeting.start_time}-${newMeeting.end_time})`,
        sent: emailResult.sent,
        messageId: emailResult.messageId || null
      });
    }

    if (!state.confirmed_meetings) state.confirmed_meetings = [];
    state.confirmed_meetings.unshift(newMeeting);

    // Keep confirmed meeting history in dedicated log as well
    if (!state.meeting_history) state.meeting_history = [];
    state.meeting_history.unshift({
      id: `mhist-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      meeting_id: newMeeting.id,
      group_id: newMeeting.group_id,
      group_name: newMeeting.group_name,
      week_key: newMeeting.week_key,
      title: newMeeting.title,
      time: `${newMeeting.day_code} (${newMeeting.date_iso}) ${newMeeting.start_time}-${newMeeting.end_time}`,
      location: newMeeting.location,
      confirmed_by: newMeeting.confirmed_by_name,
      confirmed_by_email: newMeeting.confirmed_by_email,
      attendees_count: (newMeeting.attendee_names || []).length,
      created_at: newMeeting.created_at
    });
    if (state.meeting_history.length > 200) {
      state.meeting_history = state.meeting_history.slice(0, 200);
    }
    await saveStoreState(state);

    res.json({
      ok: true,
      meeting: { ...newMeeting, googleCalendarUrl },
      emailSent: emailResult.sent,
      message: emailResult.sent
        ? `Đã chốt lịch lên Calendar chung & tự động gửi email thông báo tới các thành viên!`
        : `Đã chốt lịch "${newMeeting.title}" lên Calendar chung!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/meetings/:meetingId/remind (Protected)
 * Sends an immediate upcoming meeting reminder email via Gmail SMTP
 */
app.post('/api/meetings/:meetingId/remind', requireAuth, async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { customRecipient } = req.body || {};
    const state = req.storeState;

    const meeting = state.confirmed_meetings.find(m => m.id === meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Không tìm thấy lịch họp đã chốt này.' });
    }

    const googleCalendarUrl = buildGoogleCalendarUrl(meeting);
    const recipients = customRecipient
      ? [customRecipient]
      : Array.from(new Set([process.env.EMAIL_USER || 'gameyuno123@gmail.com', req.user.email]));

    const mailRes = await sendMeetingReminderEmail({
      meeting,
      recipients,
      googleCalendarUrl,
      minutesUntil: 30
    });

    meeting.reminder_email_sent = mailRes.sent;
    meeting.last_reminded_at = new Date().toISOString();

    logEmailEvent(state, {
      type: 'MEETING_REMINDER',
      recipient: recipients.join(', '),
      serviceAccount: SERVICE_ACCOUNT_EMAIL,
      subject: `[Meet up] Sắp tới giờ họp: ${meeting.title}`,
      sent: mailRes.sent,
      messageId: mailRes.messageId || null
    });

    await saveStoreState(state);

    res.json({
      ok: true,
      emailSent: mailRes.sent,
      recipients,
      message: mailRes.sent
        ? `Đã gửi email nhắc nhở buổi họp "${meeting.title}" tới ${recipients.join(', ')}!`
        : `Không thể gửi email lúc này (${mailRes.error || 'vui lòng thử lại sau'}).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/meetings/remind-all (Protected)
 * Dispatches reminder emails for all upcoming confirmed meetings in the current week
 */
app.post('/api/meetings/remind-all', requireAuth, async (req, res) => {
  try {
    const state = req.storeState;
    const meetings = state.confirmed_meetings || [];
    if (meetings.length === 0) {
      return res.status(400).json({ error: 'Chưa có cuộc họp nào được chốt trên lịch chung.' });
    }

    const recipients = Array.from(
      new Set([process.env.EMAIL_USER || 'gameyuno123@gmail.com', req.user.email])
    );

    let sentCount = 0;
    for (const mtg of meetings.slice(0, 3)) {
      const googleCalendarUrl = buildGoogleCalendarUrl(mtg);
      const mailRes = await sendMeetingReminderEmail({
        meeting: mtg,
        recipients,
        googleCalendarUrl,
        minutesUntil: 30
      });
      if (mailRes.sent) sentCount++;
      mtg.reminder_email_sent = mailRes.sent;
      mtg.last_reminded_at = new Date().toISOString();

      logEmailEvent(state, {
        type: 'MEETING_REMINDER_BATCH',
        recipient: recipients.join(', '),
        serviceAccount: SERVICE_ACCOUNT_EMAIL,
        subject: `[Meet up] Sắp tới giờ họp: ${mtg.title}`,
        sent: mailRes.sent,
        messageId: mailRes.messageId || null
      });
    }

    await saveStoreState(state);

    res.json({
      ok: true,
      sentCount,
      message: `Đã gửi ${sentCount} email nhắc nhở lịch họp tới các thành viên!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meetings/:meetingId/ics
 * Downloads standard RFC-5545 iCalendar (.ics) file for Google Calendar / Apple Calendar / Outlook
 */
app.get('/api/meetings/:meetingId/ics', async (req, res) => {
  try {
    const state = await getStoreState();
    const meeting = state.confirmed_meetings.find(m => m.id === req.params.meetingId);
    if (!meeting) {
      return res.status(404).send('Meeting not found');
    }

    const dateClean = (meeting.date_iso || '2026-11-11').replace(/-/g, '');
    const startClean = (meeting.start_time || '19:30').replace(':', '') + '00';
    const endClean = (meeting.end_time || '21:00').replace(':', '') + '00';
    const nowStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    const icsLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Meet up Recurring Group Scheduler//VI',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${meeting.id}@meetup.app`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART;TZID=Asia/Ho_Chi_Minh:${dateClean}T${startClean}`,
      `DTEND;TZID=Asia/Ho_Chi_Minh:${dateClean}T${endClean}`,
      `SUMMARY:[Meet up] ${meeting.title}`,
      `LOCATION:${meeting.location || 'Google Meet'}`,
      `DESCRIPTION:Nhóm: ${meeting.group_name}\\nThành viên: ${(meeting.attendee_names || []).join(', ')}\\nGhi chú: ${meeting.notes || ''}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR'
    ];

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meetup-${meeting.id}.ics"`);
    res.send(icsLines.join('\r\n'));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * Background Automatic Meeting Reminder Daemon:
 * Checks every 60 seconds if any confirmed meeting is starting within the next 60 minutes
 * and sends the reminder email automatically once.
 */
setInterval(async () => {
  try {
    const state = await getStoreState();
    const now = new Date();
    let updated = false;

    for (const mtg of state.confirmed_meetings || []) {
      if (mtg.reminder_email_sent) continue;
      if (!mtg.date_iso || !mtg.start_time) continue;

      const [yyyy, mm, dd] = mtg.date_iso.split('-').map(Number);
      const [hh, min] = mtg.start_time.split(':').map(Number);
      const mtgTime = new Date(yyyy, mm - 1, dd, hh, min, 0);
      const diffMinutes = Math.round((mtgTime.getTime() - now.getTime()) / 60000);

      if (diffMinutes > 0 && diffMinutes <= 60) {
        const googleCalendarUrl = buildGoogleCalendarUrl(mtg);
        const recipients = [process.env.EMAIL_USER || 'gameyuno123@gmail.com'];
        const res = await sendMeetingReminderEmail({
          meeting: mtg,
          recipients,
          googleCalendarUrl,
          minutesUntil: diffMinutes
        });
        mtg.reminder_email_sent = true;
        mtg.last_reminded_at = new Date().toISOString();
        logEmailEvent(state, {
          type: 'AUTO_MEETING_REMINDER',
          recipient: recipients.join(', '),
          subject: `[Nhắc lịch tự động] ${mtg.title} (còn ${diffMinutes} phút)`,
          sent: res.sent
        });
        updated = true;
      }
    }

    if (updated) {
      await saveStoreState(state);
    }
  } catch (_) {}
}, 60 * 1000);

// Fallback SPA route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`\n==================================================================`);
  console.log(`  Meet up Recurring Crew Scheduler running at http://localhost:${PORT}`);
  console.log(`  Supabase Project: ${process.env.SUPABASE_URL}`);
  console.log(`  Gmail Service:    ${process.env.EMAIL_USER}`);
  console.log(`==================================================================\n`);
  await getStoreState();
});

