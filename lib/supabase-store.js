import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET_ID = 'tossup_store';
const STATE_OBJECT_KEY = 'meetup_clean_state_v2.json';

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

let cachedState = null;
let sqlTablesAvailable = null; // null = unknown, true = Postgres tables ready, false = fallback to Supabase Storage JSON

/**
 * Compute ISO Week Key (e.g. "2026-W45") and Monday-Sunday date map for a given reference date or offset
 */
export function getWeekMetadata(weekOffset = 0) {
  // Base reference: current week starting Monday
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMonday = (day === 0 ? -6 : 1 - day) + (weekOffset * 7);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);

  // Compute ISO week number
  const tempDate = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
  const dayNum = tempDate.getUTCDay() || 7;
  tempDate.setUTCDate(tempDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tempDate - yearStart) / 86400000) + 1) / 7);
  const weekKey = `${tempDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;

  const dayCodes = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const dayLabelsVi = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];
  const days = dayCodes.map((code, idx) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + idx);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return {
      code,
      labelVi: dayLabelsVi[idx],
      dayNum: d.getDate(),
      monthNum: d.getMonth() + 1,
      dateIso: `${yyyy}-${mm}-${dd}`
    };
  });

  const sunday = days[6];
  const rangeLabel = `${days[0].dayNum}/${days[0].monthNum} – ${sunday.dayNum}/${sunday.monthNum}/${monday.getFullYear()}`;

  return {
    weekKey,
    weekOffset,
    rangeLabel,
    days
  };
}

/**
 * Clean initial state — zero mockup data.
 * Every newly registered account starts with a completely clean slate.
 */
export function buildInitialSeedState() {
  return {
    version: 2,
    project_ref: 'cbizvzvbdkykcrydckwi',
    updated_at: new Date().toISOString(),
    users: [],
    groups: [],
    group_members: [],
    group_invitations: [],
    availability_votes: [],
    confirmed_meetings: [],
    voting_history: [],
    meeting_history: [],
    otps: [],
    email_logs: []
  };
}

/**
 * Ensure Supabase Storage Bucket exists and load or seed state
 */
export async function getStoreState() {
  if (cachedState) {
    return enforceWeeklyAutoReset(cachedState);
  }

  // Ensure bucket exists on Supabase
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: BUCKET_ID, name: BUCKET_ID, public: false })
    });
  } catch (_) {}

  // Try loading existing state from Supabase Storage
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_ID}/${STATE_OBJECT_KEY}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.groups)) {
        if (!Array.isArray(data.group_invitations)) data.group_invitations = [];
        if (!Array.isArray(data.voting_history)) data.voting_history = [];
        if (!Array.isArray(data.meeting_history)) data.meeting_history = [];
        cachedState = enforceWeeklyAutoReset(data);
        return cachedState;
      }
    }
  } catch (err) {
    console.warn('[SupabaseStore] Could not read remote state, initializing seed:', err.message);
  }

  // Initialize seed state and save to Supabase
  cachedState = buildInitialSeedState();
  await saveStoreState(cachedState);
  await syncSeedUsersToSupabaseAuth(cachedState.users);
  return cachedState;
}

/**
 * Persist state to Supabase Storage AND mirror to Postgres tables if SQL migration has been applied
 */
export async function saveStoreState(state) {
  state.updated_at = new Date().toISOString();
  cachedState = state;

  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_ID}/${STATE_OBJECT_KEY}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true'
      },
      body: JSON.stringify(state)
    });
  } catch (err) {
    console.error('[SupabaseStore] Failed to persist state to Supabase Storage:', err.message);
  }

  // Also check if public.groups table is created in Postgres and mirror transparently
  if (sqlTablesAvailable !== false) {
    try {
      const { error } = await supabaseAdmin.from('groups').select('id').limit(1);
      if (!error) {
        sqlTablesAvailable = true;
        await supabaseAdmin.from('groups').upsert(
          state.groups.map(g => ({
            id: g.id,
            name: g.name,
            description: g.description,
            category: g.category,
            location: g.location,
            invite_code: g.invite_code,
            min_quorum: g.min_quorum,
            duration_minutes: g.duration_minutes,
            manager_email: g.manager_email,
            manager_mode_default: g.manager_mode_default,
            auto_reset_weekly: g.auto_reset_weekly,
            active_week_key: g.active_week_key
          }))
        );
      } else {
        sqlTablesAvailable = false;
      }
    } catch (_) {
      sqlTablesAvailable = false;
    }
  }

  return state;
}

/**
 * Sync seed & registered users to Supabase Auth (auth.users) via Admin API
 */
export async function syncSeedUsersToSupabaseAuth(users) {
  try {
    const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 100 });
    const existingEmails = new Set((existingList?.users || []).map(u => (u.email || '').toLowerCase()));

    for (const u of users) {
      if (!existingEmails.has(u.email.toLowerCase())) {
        await supabaseAdmin.auth.admin.createUser({
          email: u.email,
          password: 'Tossup@2026',
          email_confirm: true,
          user_metadata: {
            name: u.name,
            avatar_color: u.avatar_color,
            theme: u.theme,
            color_mode: u.color_mode
          },
          app_metadata: {
            role: u.role // Per Supabase security checklist: store role in app_metadata, not user_metadata
          }
        });
      }
    }
  } catch (err) {
    console.warn('[SupabaseAuth] Sync users info:', err.message);
  }
}

/**
 * Automatic Weekly Rollover Engine:
 * When the real ISO week advances (or when a group has auto_reset_weekly = true),
 * active_week_key automatically updates to the current week so every group starts fresh each week
 * while preserving historical weeks cleanly.
 */
export function enforceWeeklyAutoReset(state) {
  const currentWeek = getWeekMetadata(0).weekKey;
  let changed = false;

  for (const grp of state.groups || []) {
    if (grp.auto_reset_weekly && grp.active_week_key !== currentWeek) {
      grp.last_reset_from_week = grp.active_week_key;
      grp.active_week_key = currentWeek;
      grp.last_reset_at = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    saveStoreState(state).catch(() => {});
  }
  return state;
}

