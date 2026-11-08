import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET_ID = 'tossup_store';
const STATE_OBJECT_KEY = 'tossup_state_v1.json';

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
 * Initial rich seed data matching the Toss-up screenshot (TUE 17 3/4, WED 18 4/4 best overlap, THU 19 2/4, FRI 20 2/4)
 * and supporting multi-group comparison + Manager Mode
 */
export function buildInitialSeedState() {
  const currentWeek = getWeekMetadata(0);
  const wk = currentWeek.weekKey;
  const dayMap = Object.fromEntries(currentWeek.days.map(d => [d.code, d.dateIso]));

  const defaultPassHash = bcrypt.hashSync('Tossup@2026', 10);

  const users = [
    {
      id: 'usr-manager-01',
      email: 'gameyuno123@gmail.com',
      name: 'Minh Quân (Lead Manager)',
      role: 'manager',
      avatar_color: '#3D7A5A',
      theme: 'warm-paper',
      color_mode: 'light',
      password_hash: defaultPassHash,
      created_at: new Date().toISOString()
    },
    {
      id: 'usr-member-02',
      email: 'linh.nguyen@uel.edu.vn',
      name: 'Khánh Linh',
      role: 'member',
      avatar_color: '#E85A4F',
      theme: 'warm-paper',
      color_mode: 'light',
      password_hash: defaultPassHash,
      created_at: new Date().toISOString()
    },
    {
      id: 'usr-member-03',
      email: 'hoang.tran@uel.edu.vn',
      name: 'Hoàng Trần',
      role: 'member',
      avatar_color: '#2E6B8E',
      theme: 'warm-paper',
      color_mode: 'light',
      password_hash: defaultPassHash,
      created_at: new Date().toISOString()
    },
    {
      id: 'usr-member-04',
      email: 'thao.le@uel.edu.vn',
      name: 'Phương Thảo',
      role: 'member',
      avatar_color: '#C88A2E',
      theme: 'warm-paper',
      color_mode: 'light',
      password_hash: defaultPassHash,
      created_at: new Date().toISOString()
    },
    {
      id: 'usr-member-05',
      email: 'duc.pham@uel.edu.vn',
      name: 'Đức Phạm',
      role: 'member',
      avatar_color: '#7A5486',
      theme: 'warm-paper',
      color_mode: 'light',
      password_hash: defaultPassHash,
      created_at: new Date().toISOString()
    }
  ];

  const groups = [
    {
      id: 'grp-product-sprint',
      name: 'Product Core Sync',
      description: 'Họp định kỳ chốt roadmap sản phẩm & review sprint hàng tuần (4 thành viên chủ chốt)',
      category: 'Product & Engineering',
      location: 'Phòng Studio B2 · Google Meet',
      invite_code: 'SPRINT-W45',
      min_quorum: 4,
      duration_minutes: 90,
      manager_email: 'gameyuno123@gmail.com',
      manager_mode_default: true,
      auto_reset_weekly: true,
      active_week_key: wk,
      created_at: new Date().toISOString()
    },
    {
      id: 'grp-ai-research',
      name: 'AI Research & Model Lab',
      description: 'Nhóm nghiên cứu khoa học & đánh giá thực nghiệm mô hình tuần tự hàng tuần',
      category: 'Research Crew',
      location: 'Lab AI 302 · Microsoft Teams',
      invite_code: 'AILAB-2026',
      min_quorum: 3,
      duration_minutes: 90,
      manager_email: 'gameyuno123@gmail.com',
      manager_mode_default: true,
      auto_reset_weekly: true,
      active_week_key: wk,
      created_at: new Date().toISOString()
    },
    {
      id: 'grp-badminton-club',
      name: 'CLB Cầu Lông & Dinner Tối',
      description: 'Giao lưu thể thao & ăn tối gắn kết team sau giờ làm mỗi tuần',
      category: 'Weekly Crew',
      location: 'Sân Westpark Court 3',
      invite_code: 'CREW-PLAY',
      min_quorum: 3,
      duration_minutes: 90,
      manager_email: 'gameyuno123@gmail.com',
      manager_mode_default: false,
      auto_reset_weekly: true,
      active_week_key: wk,
      created_at: new Date().toISOString()
    }
  ];

  const group_members = [
    // Group 1: Product Core Sync (4 members — matches 3/4, 4/4, 2/4, 2/4 screenshot!)
    { group_id: 'grp-product-sprint', user_email: 'gameyuno123@gmail.com', user_name: 'Minh Quân (Lead Manager)', role: 'manager', avatar_color: '#3D7A5A' },
    { group_id: 'grp-product-sprint', user_email: 'linh.nguyen@uel.edu.vn', user_name: 'Khánh Linh', role: 'member', avatar_color: '#E85A4F' },
    { group_id: 'grp-product-sprint', user_email: 'hoang.tran@uel.edu.vn', user_name: 'Hoàng Trần', role: 'member', avatar_color: '#2E6B8E' },
    { group_id: 'grp-product-sprint', user_email: 'thao.le@uel.edu.vn', user_name: 'Phương Thảo', role: 'member', avatar_color: '#C88A2E' },

    // Group 2: AI Research Lab (4 members)
    { group_id: 'grp-ai-research', user_email: 'gameyuno123@gmail.com', user_name: 'Minh Quân (Lead Manager)', role: 'manager', avatar_color: '#3D7A5A' },
    { group_id: 'grp-ai-research', user_email: 'linh.nguyen@uel.edu.vn', user_name: 'Khánh Linh', role: 'member', avatar_color: '#E85A4F' },
    { group_id: 'grp-ai-research', user_email: 'duc.pham@uel.edu.vn', user_name: 'Đức Phạm', role: 'member', avatar_color: '#7A5486' },
    { group_id: 'grp-ai-research', user_email: 'hoang.tran@uel.edu.vn', user_name: 'Hoàng Trần', role: 'member', avatar_color: '#2E6B8E' },

    // Group 3: Badminton & Dinner Crew (4 members)
    { group_id: 'grp-badminton-club', user_email: 'gameyuno123@gmail.com', user_name: 'Minh Quân (Lead Manager)', role: 'manager', avatar_color: '#3D7A5A' },
    { group_id: 'grp-badminton-club', user_email: 'thao.le@uel.edu.vn', user_name: 'Phương Thảo', role: 'member', avatar_color: '#C88A2E' },
    { group_id: 'grp-badminton-club', user_email: 'duc.pham@uel.edu.vn', user_name: 'Đức Phạm', role: 'member', avatar_color: '#7A5486' },
    { group_id: 'grp-badminton-club', user_email: 'linh.nguyen@uel.edu.vn', user_name: 'Khánh Linh', role: 'member', avatar_color: '#E85A4F' }
  ];

  // Availability votes designed so Group 1 reproduces the exact Toss-up overlap cards:
  // TUE: 19:30-21:00 -> 3/4 (Minh Quân, Khánh Linh, Hoàng Trần)
  // WED: 19:30-21:00 -> 4/4 · best overlap (All 4 members including Manager!)
  // THU: 20:00-21:30 -> 2/4 (Khánh Linh, Hoàng Trần — Manager is busy on THU 20:00, free 14:00-16:00)
  // FRI: 17:00-19:00 -> 2/4 (Minh Quân, Phương Thảo)
  const availability_votes = [
    // --- GROUP 1: Product Core Sync ---
    {
      group_id: 'grp-product-sprint',
      week_key: wk,
      user_email: 'gameyuno123@gmail.com',
      user_name: 'Minh Quân (Lead Manager)',
      is_manager: true,
      slots: {
        MON: ['09:00', '09:30', '10:00'],
        TUE: ['19:30', '20:00', '20:30'],
        WED: ['19:30', '20:00', '20:30'],
        THU: ['20:00', '20:30', '21:00'],
        FRI: ['17:00', '17:30', '18:00', '18:30'],
        SAT: ['09:30', '10:00', '10:30']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-product-sprint',
      week_key: wk,
      user_email: 'linh.nguyen@uel.edu.vn',
      user_name: 'Khánh Linh',
      is_manager: false,
      slots: {
        MON: ['09:00', '09:30', '10:00'],
        TUE: ['19:30', '20:00', '20:30'],
        WED: ['19:30', '20:00', '20:30'],
        THU: ['20:00', '20:30', '21:00'],
        SAT: ['09:30', '10:00', '10:30']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-product-sprint',
      week_key: wk,
      user_email: 'hoang.tran@uel.edu.vn',
      user_name: 'Hoàng Trần',
      is_manager: false,
      slots: {
        TUE: ['19:30', '20:00', '20:30'],
        WED: ['19:30', '20:00', '20:30'],
        THU: ['14:00', '14:30', '15:00'],
        SAT: ['09:30', '10:00', '10:30']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-product-sprint',
      week_key: wk,
      user_email: 'thao.le@uel.edu.vn',
      user_name: 'Phương Thảo',
      is_manager: false,
      slots: {
        MON: ['09:00', '09:30', '10:00'],
        WED: ['19:30', '20:00', '20:30'],
        FRI: ['17:00', '17:30', '18:00', '18:30']
      },
      updated_at: new Date().toISOString()
    },

    // --- GROUP 2: AI Research & Model Lab ---
    {
      group_id: 'grp-ai-research',
      week_key: wk,
      user_email: 'gameyuno123@gmail.com',
      user_name: 'Minh Quân (Lead Manager)',
      is_manager: true,
      slots: {
        TUE: ['14:00', '14:30', '15:00', '15:30'],
        WED: ['19:30', '20:00', '20:30'],
        THU: ['09:30', '10:00', '10:30', '11:00'],
        FRI: ['14:00', '14:30', '15:00']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-ai-research',
      week_key: wk,
      user_email: 'linh.nguyen@uel.edu.vn',
      user_name: 'Khánh Linh',
      is_manager: false,
      slots: {
        TUE: ['14:00', '14:30', '15:00', '15:30'],
        WED: ['19:30', '20:00', '20:30'],
        THU: ['09:30', '10:00', '10:30', '11:00']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-ai-research',
      week_key: wk,
      user_email: 'duc.pham@uel.edu.vn',
      user_name: 'Đức Phạm',
      is_manager: false,
      slots: {
        TUE: ['14:00', '14:30', '15:00', '15:30'],
        THU: ['09:30', '10:00', '10:30', '11:00'],
        FRI: ['14:00', '14:30', '15:00']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-ai-research',
      week_key: wk,
      user_email: 'hoang.tran@uel.edu.vn',
      user_name: 'Hoàng Trần',
      is_manager: false,
      slots: {
        WED: ['19:30', '20:00', '20:30'],
        THU: ['09:30', '10:00', '10:30', '11:00']
      },
      updated_at: new Date().toISOString()
    },

    // --- GROUP 3: CLB Cầu Lông & Dinner Tối ---
    {
      group_id: 'grp-badminton-club',
      week_key: wk,
      user_email: 'gameyuno123@gmail.com',
      user_name: 'Minh Quân (Lead Manager)',
      is_manager: true,
      slots: {
        WED: ['19:30', '20:00', '20:30'],
        SAT: ['18:00', '18:30', '19:00', '19:30'],
        SUN: ['17:30', '18:00', '18:30', '19:00']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-badminton-club',
      week_key: wk,
      user_email: 'thao.le@uel.edu.vn',
      user_name: 'Phương Thảo',
      is_manager: false,
      slots: {
        SAT: ['18:00', '18:30', '19:00', '19:30'],
        SUN: ['17:30', '18:00', '18:30', '19:00']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-badminton-club',
      week_key: wk,
      user_email: 'duc.pham@uel.edu.vn',
      user_name: 'Đức Phạm',
      is_manager: false,
      slots: {
        SAT: ['18:00', '18:30', '19:00', '19:30'],
        SUN: ['17:30', '18:00', '18:30', '19:00']
      },
      updated_at: new Date().toISOString()
    },
    {
      group_id: 'grp-badminton-club',
      week_key: wk,
      user_email: 'linh.nguyen@uel.edu.vn',
      user_name: 'Khánh Linh',
      is_manager: false,
      slots: {
        SAT: ['18:00', '18:30', '19:00', '19:30']
      },
      updated_at: new Date().toISOString()
    }
  ];

  const confirmed_meetings = [
    {
      id: 'mtg-confirmed-01',
      group_id: 'grp-product-sprint',
      group_name: 'Product Core Sync',
      week_key: wk,
      day_code: 'WED',
      date_iso: dayMap.WED,
      start_time: '19:30',
      end_time: '21:00',
      location: 'Phòng Studio B2 · Google Meet',
      title: 'Product Core Sync — Review Sprint & Roadmap',
      notes: 'Chốt 4/4 thành viên rảnh (Best Overlap + Khớp lịch Manager Minh Quân)',
      confirmed_by_email: 'gameyuno123@gmail.com',
      confirmed_by_name: 'Minh Quân (Lead Manager)',
      manager_matched: true,
      attendee_emails: ['gameyuno123@gmail.com', 'linh.nguyen@uel.edu.vn', 'hoang.tran@uel.edu.vn', 'thao.le@uel.edu.vn'],
      attendee_names: ['Minh Quân (Lead Manager)', 'Khánh Linh', 'Hoàng Trần', 'Phương Thảo'],
      confirmation_email_sent: true,
      reminder_email_sent: false,
      created_at: new Date().toISOString()
    },
    {
      id: 'mtg-confirmed-02',
      group_id: 'grp-ai-research',
      group_name: 'AI Research & Model Lab',
      week_key: wk,
      day_code: 'THU',
      date_iso: dayMap.THU,
      start_time: '09:30',
      end_time: '11:30',
      location: 'Lab AI 302 · Microsoft Teams',
      title: 'AI Research Lab — Đối chiếu kết quả Benchmark tuần',
      notes: 'Chốt 4/4 thành viên rảnh buổi sáng Thứ 5',
      confirmed_by_email: 'gameyuno123@gmail.com',
      confirmed_by_name: 'Minh Quân (Lead Manager)',
      manager_matched: true,
      attendee_emails: ['gameyuno123@gmail.com', 'linh.nguyen@uel.edu.vn', 'duc.pham@uel.edu.vn', 'hoang.tran@uel.edu.vn'],
      attendee_names: ['Minh Quân (Lead Manager)', 'Khánh Linh', 'Đức Phạm', 'Hoàng Trần'],
      confirmation_email_sent: true,
      reminder_email_sent: false,
      created_at: new Date().toISOString()
    }
  ];

  return {
    version: 1,
    project_ref: 'cbizvzvbdkykcrydckwi',
    updated_at: new Date().toISOString(),
    users,
    groups,
    group_members,
    availability_votes,
    confirmed_meetings,
    voting_history: [
      {
        id: 'hist-vote-seed-01',
        group_id: 'grp-product-sprint',
        group_name: 'Product Core Sync',
        week_key: wk,
        user_email: 'gameyuno123@gmail.com',
        user_name: 'Minh Quân (Lead Manager)',
        slots_count: 17,
        action: 'vote_submitted',
        created_at: new Date(Date.now() - 3600000 * 2).toISOString()
      },
      {
        id: 'hist-vote-seed-02',
        group_id: 'grp-product-sprint',
        group_name: 'Product Core Sync',
        week_key: wk,
        user_email: 'linh.nguyen@uel.edu.vn',
        user_name: 'Khánh Linh',
        slots_count: 15,
        action: 'vote_submitted',
        created_at: new Date(Date.now() - 3600000 * 1.5).toISOString()
      }
    ],
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

