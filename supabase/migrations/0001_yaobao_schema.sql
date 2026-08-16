-- 药宝 PillPal · Supabase 后端 schema（与线上 idxzxnxfcpazdtaossna 保持一致）
-- =====================================================================
-- 设计要点：
--  1. 所有对象以 yb_ 前缀命名 —— 本项目与其它 app 共用一个 Supabase 项目，
--     除 yb_ 之外的任何东西都不得触碰。
--  2. 8 张表全部开启 RLS 且【零策略】。anon / authenticated 虽持有默认
--     GRANT，但 RLS 一开、无策略即无行可达 —— 数据只能经下面的 RPC 读写。
--  3. 所有 RPC 为 SECURITY DEFINER 且 search_path 锁定，以家庭码 + PIN 哈希
--     作为访问闸门；写操作额外校验 PIN。两个内部函数 yb_resolve / yb_snapshot
--     不授予 anon EXECUTE，防止匿名者绕过 PIN 直接枚举家庭。
--  4. PIN 明文永不落库：前端用 WebCrypto 对 `yaobao:${familyId}:${pin}`
--     做 SHA-256，只上传哈希。
-- 本文件是「按线上现状重建」的合并快照，可在全新项目上一次性执行。
-- =====================================================================

-- ------------------------------------------------------------------ 表
create table if not exists public.yb_families (
  id              uuid primary key default gen_random_uuid(),
  family_code     text not null unique,
  admin_pin_hash  text not null,
  display_name    text,
  elder_name      text,
  selected_pet_id text default 'bunny',
  pet_level       integer default 4,
  pet_points      integer default 75,
  pet_health      integer default 85,
  streak_days     integer default 0,
  last_take_date  date,
  font_scale      text default 'normal',
  high_contrast   boolean default false,
  voice_enabled   boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.yb_medications (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.yb_families(id) on delete cascade,
  name       text not null,
  dose       text,
  times      text[] not null default '{}',
  meal_rel   text,
  icon       text default '💊',
  color      text,
  active     boolean default true,
  sort_order integer default 0,
  source     text default 'manual',
  created_at timestamptz default now()
);

create table if not exists public.yb_family_members (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.yb_families(id) on delete cascade,
  name       text not null,
  relation   text,
  avatar     text default '👤',
  phone      text,
  role       text default 'caregiver',
  sort_order integer default 0,
  created_at timestamptz default now()
);

create table if not exists public.yb_medical_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.yb_families(id) on delete cascade,
  hospital    text,
  doctor      text,
  visit_date  date,
  follow_date date,
  content     text,
  tags        text[] default '{}',
  source      text default 'manual',
  created_at  timestamptz default now()
);

create table if not exists public.yb_dose_logs (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.yb_families(id) on delete cascade,
  medication_id uuid references public.yb_medications(id) on delete set null,
  med_name      text,
  scheduled_at  timestamptz,
  taken         boolean not null,
  taken_at      timestamptz default now(),
  actor         text,
  via           text default 'tap',
  local_date    date not null
);

create table if not exists public.yb_notes (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.yb_families(id) on delete cascade,
  author     text not null,
  text       text not null,
  read_at    timestamptz,
  created_at timestamptz default now()
);

-- 为后续 AI 语音/健康信号预留（当前前端尚未写入）
create table if not exists public.yb_chat_turns (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.yb_families(id) on delete cascade,
  role       text not null,
  text       text not null,
  audio_ms   integer,
  created_at timestamptz default now()
);

create table if not exists public.yb_health_signals (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.yb_families(id) on delete cascade,
  kind       text,
  value      text,
  raw_text   text,
  local_date date not null,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------------ 索引
create index if not exists yb_medications_family     on public.yb_medications  (family_id);
create index if not exists yb_family_members_family  on public.yb_family_members (family_id);
create index if not exists yb_medical_logs_family    on public.yb_medical_logs (family_id, visit_date desc);
create index if not exists yb_dose_logs_family_date  on public.yb_dose_logs    (family_id, local_date);
create index if not exists yb_notes_family           on public.yb_notes        (family_id, created_at desc);
create index if not exists yb_chat_turns_family      on public.yb_chat_turns   (family_id, created_at desc);
create index if not exists yb_health_signals_family  on public.yb_health_signals (family_id, local_date desc);

-- ------------------------------------------------------------------ RLS
-- 全开、零策略：匿名 key 经 PostgREST 无行可达，数据仅经下方 RPC 出入。
alter table public.yb_families       enable row level security;
alter table public.yb_medications    enable row level security;
alter table public.yb_family_members enable row level security;
alter table public.yb_medical_logs   enable row level security;
alter table public.yb_dose_logs      enable row level security;
alter table public.yb_notes          enable row level security;
alter table public.yb_chat_turns     enable row level security;
alter table public.yb_health_signals enable row level security;

-- =====================================================================
-- RPC —— 全部 SECURITY DEFINER，search_path 锁定 public, pg_temp
-- =====================================================================

-- 内部：家庭码 → id（不授予 anon）
create or replace function public.yb_resolve(p_code text)
returns uuid language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  select id from public.yb_families where family_code = lower(trim(p_code));
$$;

-- PIN 校验（哈希比对）
create or replace function public.yb_verify_pin(p_code text, p_pin_hash text)
returns boolean language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  select exists (
    select 1 from public.yb_families
    where family_code = lower(trim(p_code)) and admin_pin_hash = p_pin_hash
  );
$$;

-- 内部：把某家庭当天状态打成一个 jsonb 快照（不授予 anon）
-- events 是【统一流】：服药流水(mom_take) + 家人留言(admin_note)，按时间倒序 200 条。
-- 前端 mom 视角靠 events.filter(type==='admin_note') 取留言，故两类必须并在同一数组。
create or replace function public.yb_snapshot(p_fid uuid, p_local_date date)
returns jsonb language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_fam   public.yb_families;
  v_total int;
begin
  select * into v_fam from public.yb_families where id = p_fid;
  if not found then return null; end if;

  select count(*) into v_total from public.yb_medications where family_id = p_fid and active;

  return jsonb_build_object(
    'family', jsonb_build_object(
      'id', v_fam.family_code,
      'displayName', v_fam.display_name,
      'elderName', v_fam.elder_name,
      'fontScale', v_fam.font_scale,
      'highContrast', v_fam.high_contrast,
      'voiceEnabled', v_fam.voice_enabled
    ),
    'selectedPetId', v_fam.selected_pet_id,
    'selectedPet', jsonb_build_object(
      'level', v_fam.pet_level, 'points', v_fam.pet_points,
      'targetPoints', 100, 'healthIndex', v_fam.pet_health
    ),
    'streakDays',   v_fam.streak_days,
    'lastTakeDate', coalesce(v_fam.last_take_date::text, ''),

    'medications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'dose', m.dose,
        'times', to_jsonb(m.times), 'icon', m.icon, 'color', m.color,
        'mealRel', m.meal_rel, 'source', m.source,
        'taken', coalesce(l.taken, false)
      ) order by m.sort_order, m.created_at)
      from public.yb_medications m
      left join lateral (
        select dl.taken from public.yb_dose_logs dl
        where dl.medication_id = m.id and dl.local_date = p_local_date
        order by dl.taken_at desc limit 1
      ) l on true
      where m.family_id = p_fid and m.active
    ), '[]'::jsonb),

    'familyMembers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', fm.id, 'name', fm.name, 'relation', fm.relation,
        'avatar', fm.avatar, 'phone', fm.phone,
        'status', '已绑定', 'permission', '可查看健康值、服药历史、留言'
      ) order by fm.sort_order, fm.created_at)
      from public.yb_family_members fm where fm.family_id = p_fid
    ), '[]'::jsonb),

    'medicalLogs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ml.id, 'hospital', ml.hospital, 'doctor', ml.doctor,
        'visitDate', ml.visit_date::text, 'followDate', ml.follow_date::text,
        'content', ml.content, 'tags', to_jsonb(ml.tags), 'source', ml.source
      ) order by ml.visit_date desc nulls last, ml.created_at desc)
      from public.yb_medical_logs ml where ml.family_id = p_fid
    ), '[]'::jsonb),

    'events', coalesce((
      select jsonb_agg(e order by (e->>'at') desc)
      from (
        select jsonb_build_object(
          'id', dl.id, 'type', 'mom_take', 'medId', dl.medication_id,
          'medName', dl.med_name, 'taken', dl.taken, 'author', dl.actor,
          'via', dl.via, 'at', dl.taken_at
        ) e, dl.taken_at as ts
        from public.yb_dose_logs dl where dl.family_id = p_fid
        union all
        select jsonb_build_object(
          'id', n.id, 'type', 'admin_note', 'author', n.author,
          'text', n.text, 'readAt', n.read_at, 'at', n.created_at
        ) e, n.created_at as ts
        from public.yb_notes n where n.family_id = p_fid
        order by ts desc limit 200
      ) x
    ), '[]'::jsonb),

    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'author', n.author, 'text', n.text,
        'readAt', n.read_at, 'at', n.created_at
      ) order by n.created_at desc)
      from (select * from public.yb_notes where family_id = p_fid
            order by created_at desc limit 100) n
    ), '[]'::jsonb),

    'weeklyHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', case when g.offs = 0 then '今天'
               else (array['周一','周二','周三','周四','周五','周六','周日'])
                    [extract(isodow from (p_local_date - g.offs))::int] end,
        'done', (
          select count(*) from (
            select distinct on (dl.medication_id) dl.taken
            from public.yb_dose_logs dl
            where dl.family_id = p_fid and dl.local_date = (p_local_date - g.offs)
            order by dl.medication_id, dl.taken_at desc
          ) t where t.taken
        ),
        'total', v_total
      ) order by g.offs desc)
      from generate_series(6, 0, -1) as g(offs)
    ), '[]'::jsonb)
  );
end $$;

-- 读取家庭快照（家庭不存在返回 null）
create or replace function public.yb_get_family(p_code text, p_local_date date)
returns jsonb language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare v_fid uuid;
begin
  v_fid := public.yb_resolve(p_code);
  if v_fid is null then return null; end if;
  return public.yb_snapshot(v_fid, p_local_date);
end $$;

-- 建家庭（含 seed：宠物 / 药品 / 成员 / 医嘱）
create or replace function public.yb_create_family(
  p_code text, p_pin_hash text, p_display_name text, p_elder_name text,
  p_local_date date, p_seed jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare v_fid uuid; v_item jsonb; v_i int := 0;
begin
  if length(coalesce(p_code,'')) < 3 or length(coalesce(p_pin_hash,'')) < 16 then
    raise exception 'invalid_arguments';
  end if;
  if public.yb_resolve(p_code) is not null then
    raise exception 'family_exists';
  end if;

  insert into public.yb_families (family_code, admin_pin_hash, display_name, elder_name, selected_pet_id)
  values (lower(trim(p_code)), p_pin_hash, p_display_name, p_elder_name,
          coalesce(p_seed->>'selectedPetId', 'bunny'))
  returning id into v_fid;

  for v_item in select * from jsonb_array_elements(coalesce(p_seed->'medications', '[]'::jsonb)) loop
    insert into public.yb_medications (family_id, name, dose, times, icon, color, sort_order)
    values (v_fid, v_item->>'name', v_item->>'dose',
            coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_item->'times','[]'::jsonb)) value), '{}'),
            coalesce(v_item->>'icon','💊'), v_item->>'color', v_i);
    v_i := v_i + 1;
  end loop;

  v_i := 0;
  for v_item in select * from jsonb_array_elements(coalesce(p_seed->'familyMembers', '[]'::jsonb)) loop
    insert into public.yb_family_members (family_id, name, relation, avatar, phone, sort_order)
    values (v_fid, v_item->>'name', v_item->>'relation',
            coalesce(v_item->>'avatar','👤'), v_item->>'phone', v_i);
    v_i := v_i + 1;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_seed->'medicalLogs', '[]'::jsonb)) loop
    insert into public.yb_medical_logs (family_id, hospital, doctor, visit_date, follow_date, content, tags)
    values (v_fid, v_item->>'hospital', v_item->>'doctor',
            nullif(v_item->>'visitDate','')::date, nullif(v_item->>'followDate','')::date,
            v_item->>'content',
            coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_item->'tags','[]'::jsonb)) value), '{}'));
  end loop;

  return public.yb_snapshot(v_fid, p_local_date);
end $$;

-- 保存配置（宠物/设置/药品/成员/医嘱）—— 需 PIN。
-- id 为合法 uuid 且属本家庭者 update，否则 insert；未列出的成员/医嘱删除，
-- 未列出的药品置 active=false 保留历史流水。
create or replace function public.yb_save_config(
  p_code text, p_pin_hash text, p_payload jsonb, p_local_date date)
returns jsonb language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_fid uuid; v_item jsonb; v_i int; v_id uuid; v_keep uuid[];
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  v_fid := public.yb_resolve(p_code);
  if v_fid is null then raise exception 'family_not_found'; end if;
  if not public.yb_verify_pin(p_code, p_pin_hash) then raise exception 'bad_pin'; end if;

  update public.yb_families set
    selected_pet_id = coalesce(p_payload->>'selectedPetId', selected_pet_id),
    pet_level   = coalesce((p_payload#>>'{selectedPet,level}')::int,       pet_level),
    pet_points  = coalesce((p_payload#>>'{selectedPet,points}')::int,      pet_points),
    pet_health  = coalesce((p_payload#>>'{selectedPet,healthIndex}')::int, pet_health),
    streak_days = coalesce((p_payload->>'streakDays')::int,                streak_days),
    last_take_date = coalesce(nullif(p_payload->>'lastTakeDate','')::date, last_take_date),
    display_name  = coalesce(p_payload#>>'{family,displayName}', display_name),
    elder_name    = coalesce(p_payload#>>'{family,elderName}',   elder_name),
    font_scale    = coalesce(p_payload#>>'{family,fontScale}',   font_scale),
    high_contrast = coalesce((p_payload#>>'{family,highContrast}')::boolean, high_contrast),
    voice_enabled = coalesce((p_payload#>>'{family,voiceEnabled}')::boolean, voice_enabled),
    updated_at = now()
  where id = v_fid;

  if p_payload ? 'medications' then
    v_keep := '{}'; v_i := 0;
    for v_item in select * from jsonb_array_elements(p_payload->'medications') loop
      v_id := case when coalesce(v_item->>'id','') ~ c_uuid then (v_item->>'id')::uuid else null end;
      if v_id is not null and exists (select 1 from public.yb_medications where id = v_id and family_id = v_fid) then
        update public.yb_medications set
          name = v_item->>'name', dose = v_item->>'dose',
          times = coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_item->'times','[]'::jsonb)) value), '{}'),
          icon = coalesce(v_item->>'icon','💊'), color = v_item->>'color',
          meal_rel = v_item->>'mealRel', source = coalesce(v_item->>'source','manual'),
          sort_order = v_i
        where id = v_id;
      else
        insert into public.yb_medications (family_id, name, dose, times, icon, color, meal_rel, source, sort_order)
        values (v_fid, v_item->>'name', v_item->>'dose',
                coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_item->'times','[]'::jsonb)) value), '{}'),
                coalesce(v_item->>'icon','💊'), v_item->>'color', v_item->>'mealRel',
                coalesce(v_item->>'source','manual'), v_i)
        returning id into v_id;
      end if;
      v_keep := v_keep || v_id; v_i := v_i + 1;
    end loop;
    update public.yb_medications set active = false
     where family_id = v_fid and active and not (id = any(v_keep));
  end if;

  if p_payload ? 'familyMembers' then
    v_keep := '{}'; v_i := 0;
    for v_item in select * from jsonb_array_elements(p_payload->'familyMembers') loop
      v_id := case when coalesce(v_item->>'id','') ~ c_uuid then (v_item->>'id')::uuid else null end;
      if v_id is not null and exists (select 1 from public.yb_family_members where id = v_id and family_id = v_fid) then
        update public.yb_family_members set
          name = v_item->>'name', relation = v_item->>'relation',
          avatar = coalesce(v_item->>'avatar','👤'), phone = v_item->>'phone', sort_order = v_i
        where id = v_id;
      else
        insert into public.yb_family_members (family_id, name, relation, avatar, phone, sort_order)
        values (v_fid, v_item->>'name', v_item->>'relation',
                coalesce(v_item->>'avatar','👤'), v_item->>'phone', v_i)
        returning id into v_id;
      end if;
      v_keep := v_keep || v_id; v_i := v_i + 1;
    end loop;
    delete from public.yb_family_members where family_id = v_fid and not (id = any(v_keep));
  end if;

  if p_payload ? 'medicalLogs' then
    v_keep := '{}';
    for v_item in select * from jsonb_array_elements(p_payload->'medicalLogs') loop
      v_id := case when coalesce(v_item->>'id','') ~ c_uuid then (v_item->>'id')::uuid else null end;
      if v_id is not null and exists (select 1 from public.yb_medical_logs where id = v_id and family_id = v_fid) then
        update public.yb_medical_logs set
          hospital = v_item->>'hospital', doctor = v_item->>'doctor',
          visit_date  = nullif(v_item->>'visitDate','')::date,
          follow_date = nullif(v_item->>'followDate','')::date,
          content = v_item->>'content',
          tags = coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_item->'tags','[]'::jsonb)) value), '{}')
        where id = v_id;
      else
        insert into public.yb_medical_logs (family_id, hospital, doctor, visit_date, follow_date, content, tags, source)
        values (v_fid, v_item->>'hospital', v_item->>'doctor',
                nullif(v_item->>'visitDate','')::date, nullif(v_item->>'followDate','')::date,
                v_item->>'content',
                coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_item->'tags','[]'::jsonb)) value), '{}'),
                coalesce(v_item->>'source','manual'))
        returning id into v_id;
      end if;
      v_keep := v_keep || v_id;
    end loop;
    delete from public.yb_medical_logs where family_id = v_fid and not (id = any(v_keep));
  end if;

  return public.yb_snapshot(v_fid, p_local_date);
end $$;

-- 记一次服药 / 漏服。成长数学 + §6.3 伦理下限（健康值最低 15，永不归零）。
-- 返回 { levelUp, snapshot }。
create or replace function public.yb_log_dose(
  p_code text, p_medication_id uuid, p_taken boolean,
  p_actor text, p_via text, p_local_date date)
returns jsonb language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_fid uuid; v_fam public.yb_families; v_name text;
  v_points int; v_level int; v_health int; v_streak int; v_levelup boolean := false;
begin
  v_fid := public.yb_resolve(p_code);
  if v_fid is null then raise exception 'family_not_found'; end if;

  select name into v_name from public.yb_medications
   where id = p_medication_id and family_id = v_fid and active;
  if v_name is null then raise exception 'medication_not_found'; end if;

  insert into public.yb_dose_logs (family_id, medication_id, med_name, taken, actor, via, local_date)
  values (v_fid, p_medication_id, v_name, p_taken,
          coalesce(p_actor,'家人'), coalesce(p_via,'tap'), p_local_date);

  select * into v_fam from public.yb_families where id = v_fid for update;
  v_points := v_fam.pet_points; v_level := v_fam.pet_level;
  v_health := v_fam.pet_health; v_streak := v_fam.streak_days;

  if p_taken then
    v_points := least(v_points + 25, 100);
    if v_points >= 100 then v_level := v_level + 1; v_points := 0; v_levelup := true; end if;
    v_health := least(v_health + 10, 100);
    if v_fam.last_take_date is distinct from p_local_date then
      v_streak := case
        when v_fam.last_take_date is null then v_streak + 1
        when v_fam.last_take_date = p_local_date - 1 then v_streak + 1
        else 1 end;
    end if;
    update public.yb_families
       set pet_points = v_points, pet_level = v_level, pet_health = v_health,
           streak_days = v_streak, last_take_date = p_local_date, updated_at = now()
     where id = v_fid;
  else
    v_points := greatest(v_points - 25, 0);
    v_health := greatest(v_health - 10, 15);
    update public.yb_families
       set pet_points = v_points, pet_health = v_health, updated_at = now()
     where id = v_fid;
  end if;

  return jsonb_build_object(
    'levelUp',  v_levelup,
    'snapshot', public.yb_snapshot(v_fid, p_local_date)
  );
end $$;

-- 家人留言 —— 需 PIN。
create or replace function public.yb_add_note(
  p_code text, p_pin_hash text, p_author text, p_text text, p_local_date date)
returns jsonb language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare v_fid uuid;
begin
  v_fid := public.yb_resolve(p_code);
  if v_fid is null then raise exception 'family_not_found'; end if;
  if not public.yb_verify_pin(p_code, p_pin_hash) then raise exception 'bad_pin'; end if;
  if length(coalesce(trim(p_text),'')) = 0 then raise exception 'empty_text'; end if;

  insert into public.yb_notes (family_id, author, text)
  values (v_fid, coalesce(p_author,'家人'), left(p_text, 500));

  return public.yb_snapshot(v_fid, p_local_date);
end $$;

-- 留言标记已读（未来「未读回执」用）
create or replace function public.yb_mark_note_read(p_code text, p_note_id uuid)
returns boolean language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare v_fid uuid;
begin
  v_fid := public.yb_resolve(p_code);
  if v_fid is null then return false; end if;
  update public.yb_notes set read_at = now()
   where id = p_note_id and family_id = v_fid and read_at is null;
  return true;
end $$;

-- 家人端读近 N 天健康关心信号（AI 陪伴时由 yb-ai Edge Function 以 service-role 静默写入）。
-- 只读、按家庭码解析，最多 50 条 / N∈[1,90] 天；措辞中性，判断权留给家人和医生（F11.4）。
create or replace function public.yb_health_recent(p_code text, p_days integer default 14)
returns jsonb language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  from (
    select hs.kind, hs.value, hs.raw_text,
           to_char(hs.local_date, 'YYYY-MM-DD') as local_date,
           hs.created_at
    from public.yb_health_signals hs
    where hs.family_id = public.yb_resolve(p_code)
      and hs.created_at >= now() - make_interval(days => greatest(1, least(90, coalesce(p_days, 14))))
    order by hs.created_at desc
    limit 50
  ) t;
$$;

-- ------------------------------------------------------------------ EXECUTE 授权
-- 内部函数收回 anon/authenticated，杜绝匿名绕过 PIN 直呼 yb_snapshot/yb_resolve。
revoke all on function public.yb_resolve(text)         from anon, authenticated;
revoke all on function public.yb_snapshot(uuid, date)  from anon, authenticated;

-- 面向客户端的 8 个 RPC 允许 anon 执行（前端持 publishable/anon key 调用）。
grant execute on function public.yb_get_family(text, date)                         to anon, authenticated;
grant execute on function public.yb_verify_pin(text, text)                         to anon, authenticated;
grant execute on function public.yb_create_family(text, text, text, text, date, jsonb) to anon, authenticated;
grant execute on function public.yb_save_config(text, text, jsonb, date)           to anon, authenticated;
grant execute on function public.yb_log_dose(text, uuid, boolean, text, text, date) to anon, authenticated;
grant execute on function public.yb_add_note(text, text, text, text, date)         to anon, authenticated;
grant execute on function public.yb_mark_note_read(text, uuid)                     to anon, authenticated;
grant execute on function public.yb_health_recent(text, integer)                   to anon, authenticated;
