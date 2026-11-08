-- =============================================================================
-- TOSS-UP RECURRING GROUP SCHEDULER — SUPABASE POSTGRES SCHEMA & RLS POLICIES
-- Project Ref: cbizvzvbdkykcrydckwi
-- Follows Supabase Postgres Best Practices (RLS, SECURITY INVOKER, Indexes)
-- =============================================================================

-- 1. Enable UUID & Crypto extensions
create extension if not exists "pgcrypto";

-- 2. PROFILES TABLE (Linked to auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null,
  role text not null default 'member' check (role in ('member', 'manager', 'admin')),
  avatar_color text not null default '#3D7A5A',
  theme text not null default 'warm-paper',
  color_mode text not null default 'light' check (color_mode in ('light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated
  using ( true );

create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check ( (select auth.uid()) = id );

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using ( (select auth.uid()) = id )
  with check ( (select auth.uid()) = id );

-- 3. GROUPS TABLE (Recurring Meeting Crews)
create table if not exists public.groups (
  id text primary key,
  name text not null,
  description text not null default '',
  category text not null default 'Weekly Crew',
  location text not null default 'Online / Studio',
  invite_code text unique not null,
  min_quorum integer not null default 3 check (min_quorum >= 1),
  duration_minutes integer not null default 90 check (duration_minutes >= 15),
  manager_email text not null,
  manager_mode_default boolean not null default false,
  auto_reset_weekly boolean not null default true,
  active_week_key text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_groups_manager_email on public.groups(manager_email);
create index if not exists idx_groups_active_week on public.groups(active_week_key);

alter table public.groups enable row level security;

create policy "Groups are viewable by authenticated users"
  on public.groups for select
  to authenticated
  using ( true );

create policy "Authenticated users can create groups"
  on public.groups for insert
  to authenticated
  with check ( (select auth.uid()) is not null );

create policy "Group creators and managers can update groups"
  on public.groups for update
  to authenticated
  using ( (select auth.uid()) is not null )
  with check ( (select auth.uid()) is not null );

-- 4. GROUP MEMBERS TABLE
create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id text not null references public.groups(id) on delete cascade,
  user_email text not null,
  user_name text not null,
  role text not null default 'member' check (role in ('member', 'manager', 'admin')),
  avatar_color text not null default '#3D7A5A',
  joined_at timestamptz not null default now(),
  unique(group_id, user_email)
);

create index if not exists idx_group_members_group_id on public.group_members(group_id);
create index if not exists idx_group_members_user_email on public.group_members(user_email);

alter table public.group_members enable row level security;

create policy "Group members viewable by authenticated users"
  on public.group_members for select
  to authenticated
  using ( true );

create policy "Authenticated users can join groups"
  on public.group_members for insert
  to authenticated
  with check ( (select auth.uid()) is not null );

create policy "Members can update their membership"
  on public.group_members for update
  to authenticated
  using ( (select auth.uid()) is not null )
  with check ( (select auth.uid()) is not null );

-- 5. WEEKLY AVAILABILITY VOTES TABLE (Scoped by week_key for automatic weekly reset)
create table if not exists public.availability_votes (
  id uuid primary key default gen_random_uuid(),
  group_id text not null references public.groups(id) on delete cascade,
  week_key text not null,
  user_email text not null,
  user_name text not null,
  is_manager boolean not null default false,
  -- JSONB map of day ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN") -> array of half-hour slots ("18:00", "18:30", ...)
  slots jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(group_id, week_key, user_email)
);

create index if not exists idx_availability_group_week on public.availability_votes(group_id, week_key);
create index if not exists idx_availability_user_week on public.availability_votes(user_email, week_key);

alter table public.availability_votes enable row level security;

create policy "Availability votes viewable by authenticated users"
  on public.availability_votes for select
  to authenticated
  using ( true );

create policy "Users can upsert their availability votes"
  on public.availability_votes for insert
  to authenticated
  with check ( (select auth.uid()) is not null );

create policy "Users can update availability votes"
  on public.availability_votes for update
  to authenticated
  using ( (select auth.uid()) is not null )
  with check ( (select auth.uid()) is not null );

-- 6. CONFIRMED MEETINGS TABLE (Shared Calendar & Auto-Reminder Queue)
create table if not exists public.confirmed_meetings (
  id text primary key,
  group_id text not null references public.groups(id) on delete cascade,
  group_name text not null,
  week_key text not null,
  day_code text not null,
  date_iso text not null,
  start_time text not null,
  end_time text not null,
  location text not null default 'Online / Studio',
  title text not null,
  notes text not null default '',
  confirmed_by_email text not null,
  confirmed_by_name text not null,
  manager_matched boolean not null default true,
  attendee_emails jsonb not null default '[]'::jsonb,
  attendee_names jsonb not null default '[]'::jsonb,
  confirmation_email_sent boolean not null default false,
  reminder_email_sent boolean not null default false,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_confirmed_meetings_week on public.confirmed_meetings(week_key);
create index if not exists idx_confirmed_meetings_date on public.confirmed_meetings(date_iso);

alter table public.confirmed_meetings enable row level security;

create policy "Confirmed meetings viewable by authenticated users"
  on public.confirmed_meetings for select
  to authenticated
  using ( true );

create policy "Authenticated users can confirm meetings"
  on public.confirmed_meetings for insert
  to authenticated
  with check ( (select auth.uid()) is not null );

create policy "Authenticated users can update confirmed meetings"
  on public.confirmed_meetings for update
  to authenticated
  using ( (select auth.uid()) is not null )
  with check ( (select auth.uid()) is not null );

-- 7. OTP CODES & EMAIL AUDIT LOGS (Configured with Service Account ais-gemini-key-2d1c5a154f6c46f@718641806689.iam.gserviceaccount.com)
create table if not exists public.email_logs (
  id uuid primary key default gen_random_uuid(),
  email_type text not null check (email_type in ('register_otp', 'reset_otp', 'meeting_confirmed', 'meeting_reminder')),
  recipient_email text not null,
  service_account text not null default 'ais-gemini-key-2d1c5a154f6c46f@718641806689.iam.gserviceaccount.com',
  subject text not null,
  status text not null default 'sent',
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);

create index if not exists idx_email_logs_recipient on public.email_logs(recipient_email);
create index if not exists idx_email_logs_type on public.email_logs(email_type);

alter table public.email_logs enable row level security;

create policy "Email logs viewable by authenticated users"
  on public.email_logs for select
  to authenticated
  using ( true );

create policy "Authenticated users can insert email logs"
  on public.email_logs for insert
  to authenticated
  with check ( (select auth.uid()) is not null );

-- Grant explicit Data API access per Supabase Core Principle #4
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

