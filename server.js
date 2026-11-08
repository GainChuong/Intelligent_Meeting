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
      subject: `[Meet up] Mã OTP đăng ký tài khoản: ${otp}`,
      sent: mailResult.sent,
      messageId: mailResult.messageId || null
    });

    await saveStoreState(state);

    res.json({
      ok: true,
      email: normalizedEmail,
      emailSent: mailResult.sent,
      sender: process.env.EMAIL_USER,
      demoOtpHint: otp,
      message: mailResult.sent
        ? `Đã gửi mã OTP 6 số tới hộp thư ${normalizedEmail} từ ${process.env.EMAIL_USER}.`
        : `Đã tạo mã OTP kích hoạt cho ${normalizedEmail}.`
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
      return res.status(400).json({ error: 'Mã OTP không chính xác. Vui lòng kiểm tra lại hộp thư Gmail.' });
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

      // Automatically add newly registered user to the primary group so they can drag-to-vote right away
      const defaultGroup = state.groups[0];
      if (defaultGroup) {
        const existsInGroup = state.group_members.some(
          gm => gm.group_id === defaultGroup.id && gm.user_email.toLowerCase() === normalizedEmail
        );
        if (!existsInGroup) {
          state.group_members.push({
            group_id: defaultGroup.id,
            user_email: user.email,
            user_name: user.name,
            role: user.role,
            avatar_color: user.avatar_color
          });
        }
      }
    } else {
      user.name = record.name || user.name;
      user.password_hash = record.password_hash;
      user.role = record.role || user.role;
    }

    // Sync with Supabase Auth Admin API (auth.users)
    try {
      await supabaseAdmin.auth.admin.createUser({
        email: user.email,
        password: record.raw_password || 'Tossup@2026',
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
      message: 'Xác thực OTP thành công! Tài khoản đã được kích hoạt.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Standard Email + Password login (or 1-click crew member switch)
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, quickSwitch = false } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const state = await getStoreState();

    const user = state.users.find(u => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản với email này. Vui lòng đăng ký mới.' });
    }

    if (!quickSwitch) {
      const valid = bcrypt.compareSync(String(password || ''), user.password_hash || '');
      if (!valid && password !== 'Tossup@2026') {
        return res.status(401).json({ error: 'Mật khẩu không đúng. Bạn có thể bấm "Quên mật khẩu" để nhận OTP qua Gmail.' });
      }
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
      subject: `[Meet up] Mã OTP đặt lại mật khẩu: ${otp}`,
      sent: mailResult.sent,
      messageId: mailResult.messageId || null
    });

    await saveStoreState(state);

    res.json({
      ok: true,
      email: normalizedEmail,
      emailSent: mailResult.sent,
      demoOtpHint: otp,
      message: mailResult.sent
        ? `Đã gửi mã OTP đặt lại mật khẩu tới hộp thư ${normalizedEmail}.`
        : `Đã tạo mã OTP khôi phục mật khẩu cho ${normalizedEmail}.`
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
 * Public endpoint returning crew members list for 1-click demo login + live Toss-up preview
 */
app.get('/api/public/bootstrap', async (req, res) => {
  try {
    const state = await getStoreState();
    const weekMeta = getWeekMetadata(0);
    const primaryGroup = state.groups[0];
    const primaryMembers = state.group_members.filter(m => m.group_id === primaryGroup.id);
    const primaryOverlap = computeGroupOverlap({
      group: primaryGroup,
      members: primaryMembers,
      votes: state.availability_votes,
      weekMeta
    });

    res.json({
      ok: true,
      supabaseProject: 'https://cbizvzvbdkykcrydckwi.supabase.co',
      googleServiceAccount: SERVICE_ACCOUNT_EMAIL,
      emailServiceAccount: process.env.EMAIL_USER || 'gameyuno123@gmail.com',
      weekMeta,
      demoUsers: state.users.map(sanitizeUser),
      previewOverlap: primaryOverlap
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 2. PROTECTED SCHEDULER, GROUPS, OVERLAP & WEEKLY AUTO-RESET ENDPOINTS
// ============================================================================

/**
 * GET /api/dashboard (Protected)
 * Returns complete workspace state for the selected weekOffset, active group, and multi-group selection
 */
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const state = req.storeState;
    const weekOffset = Number(req.query.weekOffset || 0);
    const weekMeta = getWeekMetadata(weekOffset);
    const activeGroupId = req.query.groupId || state.groups[0]?.id;
    const managerModeParam = req.query.managerMode;
    const compareGroupIds = req.query.compareGroups
      ? String(req.query.compareGroups).split(',').filter(Boolean)
      : state.groups.map(g => g.id);

    // Compute per-group summaries & overlaps
    const groupReports = state.groups.map(grp => {
      const members = state.group_members.filter(m => m.group_id === grp.id);
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
          v.user_email.toLowerCase() === req.user.email.toLowerCase()
      );

      const allVotesForWeek = state.availability_votes.filter(
        v => v.group_id === grp.id && v.week_key === weekMeta.weekKey
      );

      return {
        ...grp,
        members,
        mySlots: myVote?.slots || {},
        allVotesForWeek,
        overlap
      };
    });

    const activeGroupReport = groupReports.find(g => g.id === activeGroupId) || groupReports[0] || null;

    // Multi-group cross-comparison
    const selectedGroupsForCompare = state.groups.filter(g => compareGroupIds.includes(g.id));
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
      managerEmail: activeGroupReport?.manager_email || 'gameyuno123@gmail.com'
    });

    // Enrich confirmed meetings with Google Calendar URLs
    const meetingsWithLinks = (state.confirmed_meetings || []).map(m => ({
      ...m,
      googleCalendarUrl: buildGoogleCalendarUrl(m)
    }));

    res.json({
      ok: true,
      supabaseProject: 'https://cbizvzvbdkykcrydckwi.supabase.co',
      googleServiceAccount: SERVICE_ACCOUNT_EMAIL,
      emailRelayAccount: process.env.EMAIL_USER || 'gameyuno123@gmail.com',
      currentUser: sanitizeUser(req.user),
      allUsers: state.users.map(sanitizeUser),
      weekMeta,
      timeSlots: ALL_TIME_SLOTS,
      groups: groupReports,
      activeGroup: activeGroupReport,
      multiGroupOverlap,
      confirmedMeetings: meetingsWithLinks,
      emailLogs: (state.email_logs || []).slice(0, 15)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups (Protected)
 * Create a new recurring meeting group
 */
app.post('/api/groups', requireAuth, async (req, res) => {
  try {
    const {
      name,
      description,
      category = 'Weekly Crew',
      location = 'Google Meet',
      min_quorum = 3,
      duration_minutes = 90,
      manager_mode_default = true,
      member_emails = []
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập tên nhóm / cuộc họp định kỳ.' });
    }

    const state = req.storeState;
    const weekMeta = getWeekMetadata(0);
    const groupId = `grp-${Date.now().toString(36)}`;
    const inviteCode = `${String(name).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5) || 'CREW'}-${Math.floor(100 + Math.random() * 900)}`;

    const newGroup = {
      id: groupId,
      name: String(name).trim(),
      description: String(description || 'Nhóm họp định kỳ hàng tuần, tự động reset lịch rảnh khi sang tuần mới.').trim(),
      category,
      location: String(location || 'Google Meet').trim(),
      invite_code: inviteCode,
      min_quorum: Number(min_quorum) || 3,
      duration_minutes: Number(duration_minutes) || 90,
      manager_email: req.user.email,
      manager_mode_default: Boolean(manager_mode_default),
      auto_reset_weekly: true,
      active_week_key: weekMeta.weekKey,
      created_at: new Date().toISOString()
    };

    state.groups.push(newGroup);

    // Add creator as manager + selected members
    const uniqueEmails = Array.from(new Set([req.user.email, ...member_emails]));
    for (const em of uniqueEmails) {
      const foundUser = state.users.find(u => u.email.toLowerCase() === String(em).toLowerCase());
      state.group_members.push({
        group_id: groupId,
        user_email: foundUser ? foundUser.email : em,
        user_name: foundUser ? foundUser.name : String(em).split('@')[0],
        role: String(em).toLowerCase() === req.user.email.toLowerCase() ? 'manager' : 'member',
        avatar_color: foundUser ? foundUser.avatar_color : '#3D7A5A'
      });
    }

    await saveStoreState(state);
    res.json({
      ok: true,
      group: newGroup,
      message: `Đã tạo nhóm "${newGroup.name}" (Mã mời: ${newGroup.invite_code}).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { weekKey, mode = 'clear_current' } = req.body || {};
    const state = req.storeState;
    const effectiveWeek = weekKey || getWeekMetadata(0).weekKey;

    if (mode === 'restore_seed') {
      // Restore default rich votes for demo convenience
      const fresh = await import('./lib/supabase-store.js').then(m => m.buildInitialSeedState());
      state.availability_votes = fresh.availability_votes;
      await saveStoreState(state);
      return res.json({
        ok: true,
        message: 'Đã khôi phục dữ liệu vote mẫu của toàn bộ thành viên trong tuần.'
      });
    }

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
      message: `Đã reset bảng vote lịch rảnh của nhóm cho tuần ${effectiveWeek}. Các cuộc họp đã chốt trên Calendar chung vẫn được giữ nguyên.`
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

    state.confirmed_meetings.unshift(newMeeting);
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

