create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists platform_meta (
  key text primary key,
  value text not null
);

create table if not exists question_meta (
  key text primary key,
  value text not null
);

-- Admins: email is the unique identifier (Google OAuth only)
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Migrate: rename username -> email if the old column exists
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'admins' and column_name = 'username'
  ) then
    alter table admins rename column username to email;
  end if;
end $$;

-- Drop legacy password columns from admins if they exist
alter table admins drop column if exists password_hash;
alter table admins drop column if exists password_salt;

-- Students: email is the unique identifier (Google OAuth only)
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  access_starts_at timestamptz,
  access_expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Migrate: rename register_number -> email if the old column exists
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'students' and column_name = 'register_number'
  ) then
    alter table students rename column register_number to email;
  end if;
end $$;

-- Drop legacy columns from students if they exist
alter table students drop column if exists password_hash;
alter table students drop column if exists password_salt;
alter table students drop column if exists registered_name;

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null,
  role text not null check (role in ('admin', 'student')),
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null
);

create table if not exists session_activity (
  session_id uuid primary key,
  user_id uuid not null,
  role text not null check (role in ('admin', 'student')),
  started_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  ended_at timestamptz,
  request_count integer not null default 0
);

create table if not exists questions (
  id text primary key,
  level text not null check (level in ('basic', 'medium', 'hard')),
  source_question_no text not null,
  prompt text not null,
  sheet_name text not null,
  imported_at timestamptz not null default timezone('utc', now())
);

create table if not exists question_options (
  question_id text not null references questions(id) on delete cascade,
  option_index integer not null,
  option_text text not null,
  primary key (question_id, option_index)
);

create table if not exists answer_rows (
  id text primary key,
  question_id text not null references questions(id) on delete cascade,
  row_index integer not null,
  account text not null,
  debit numeric,
  credit numeric
);

create table if not exists quiz_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  level text not null check (level in ('basic', 'medium', 'hard')),
  question_ids text[] not null,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null
);

create table if not exists attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null unique,
  student_id uuid not null references students(id) on delete cascade,
  level text not null check (level in ('basic', 'medium', 'hard')),
  score integer not null,
  total_questions integer not null,
  percentage numeric(6, 4) not null,
  performance_label text not null check (performance_label in ('Poor', 'Good', 'Very Good', 'Excellent')),
  completed_at timestamptz not null default timezone('utc', now()),
  results_json jsonb not null
);

-- Indexes
create index if not exists idx_sessions_token_hash on sessions(token_hash);
create index if not exists idx_session_activity_user_role on session_activity(user_id, role);
create index if not exists idx_students_access_expires_at on students(access_expires_at desc);
create index if not exists idx_quiz_sessions_student_id on quiz_sessions(student_id, expires_at desc);
create index if not exists idx_attempts_student_id on attempts(student_id, completed_at desc);
create index if not exists idx_questions_level on questions(level, source_question_no);
create index if not exists idx_question_options_question_id on question_options(question_id);
create index if not exists idx_answer_rows_question_id on answer_rows(question_id, row_index);
