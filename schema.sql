-- ============================================================
-- EpicTalk — Supabase Schema (Clean Install)
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- ============================================================
-- 0. CLEAN SLATE
-- ============================================================
DROP TABLE IF EXISTS public.calls         CASCADE;
DROP TABLE IF EXISTS public.notifications CASCADE;
DROP TABLE IF EXISTS public.messages      CASCADE;
DROP TABLE IF EXISTS public.room_members  CASCADE;
DROP TABLE IF EXISTS public.rooms         CASCADE;
DROP TABLE IF EXISTS public.profiles      CASCADE;
DROP FUNCTION IF EXISTS public.get_unread_count(UUID, UUID);
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ============================================================
-- 1. EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 2. PROFILES
-- ============================================================
CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    TEXT UNIQUE NOT NULL,
  full_name   TEXT,
  avatar_url  TEXT,
  bio         TEXT DEFAULT '',
  status      TEXT DEFAULT 'offline' CHECK (status IN ('online','away','busy','offline')),
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX profiles_username_idx ON public.profiles (username);

-- ============================================================
-- 3. ROOMS
-- ============================================================
CREATE TABLE public.rooms (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT,
  description TEXT DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct','group')),
  avatar_url  TEXT,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. ROOM_MEMBERS
-- ============================================================
CREATE TABLE public.room_members (
  room_id      UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role         TEXT DEFAULT 'member' CHECK (role IN ('admin','member')),
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_idx ON public.room_members (user_id);
CREATE INDEX room_members_room_idx ON public.room_members (room_id);

-- ============================================================
-- 5. MESSAGES
-- ============================================================
CREATE TABLE public.messages (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id    UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '',
  type       TEXT DEFAULT 'text' CHECK (type IN ('text','image','file','call','system')),
  metadata   JSONB DEFAULT '{}',
  edited     BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX messages_room_idx ON public.messages (room_id, created_at DESC);

-- ============================================================
-- 6. NOTIFICATIONS
-- ============================================================
CREATE TABLE public.notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type       TEXT DEFAULT 'message' CHECK (type IN ('message','call','group_invite','mention','system')),
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT DEFAULT '',
  data       JSONB DEFAULT '{}',
  read       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX notifications_user_idx ON public.notifications (user_id, created_at DESC);

-- ============================================================
-- 7. CALLS
-- ============================================================
CREATE TABLE public.calls (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id      UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  initiated_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type         TEXT DEFAULT 'video' CHECK (type IN ('video','audio')),
  status       TEXT DEFAULT 'ringing' CHECK (status IN ('ringing','active','ended','declined','missed')),
  sdp_offer    JSONB,
  sdp_answer   JSONB,
  ended_at     TIMESTAMPTZ,
  duration_sec INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. FUNCTION: get_unread_count
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_unread_count(p_room_id UUID, p_user_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INTEGER
  FROM   public.messages m
  JOIN   public.room_members rm
    ON   rm.room_id = m.room_id AND rm.user_id = p_user_id
  WHERE  m.room_id    = p_room_id
    AND  m.sender_id <> p_user_id
    AND  m.created_at > COALESCE(rm.last_read_at, '1970-01-01'::TIMESTAMPTZ);
$$;

-- ============================================================
-- 9. TRIGGER: auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, username, full_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'username',
      LOWER(SPLIT_PART(NEW.email, '@', 1)) || '_' || SUBSTR(NEW.id::TEXT, 1, 4)
    ),
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      SPLIT_PART(NEW.email, '@', 1)
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 10. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls         ENABLE ROW LEVEL SECURITY;

-- profiles
CREATE POLICY "profiles_select_all"  ON public.profiles FOR SELECT USING (TRUE);
CREATE POLICY "profiles_insert_own"  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own"  ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- rooms
CREATE POLICY "rooms_select_member" ON public.rooms FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = rooms.id AND user_id = auth.uid())
);
CREATE POLICY "rooms_insert_auth"   ON public.rooms FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "rooms_update_admin"  ON public.rooms FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = rooms.id AND user_id = auth.uid() AND role = 'admin')
);

-- room_members
CREATE POLICY "room_members_select" ON public.room_members FOR SELECT USING (
  user_id = auth.uid() OR
  EXISTS (SELECT 1 FROM public.room_members rm2 WHERE rm2.room_id = room_members.room_id AND rm2.user_id = auth.uid())
);
CREATE POLICY "room_members_insert" ON public.room_members FOR INSERT WITH CHECK (
  user_id = auth.uid() OR
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = room_members.room_id AND user_id = auth.uid() AND role = 'admin')
);
CREATE POLICY "room_members_update_own" ON public.room_members FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "room_members_delete_own" ON public.room_members FOR DELETE USING (user_id = auth.uid());

-- messages
CREATE POLICY "messages_select_member" ON public.messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = messages.room_id AND user_id = auth.uid())
);
CREATE POLICY "messages_insert_member" ON public.messages FOR INSERT WITH CHECK (
  sender_id = auth.uid() AND
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = messages.room_id AND user_id = auth.uid())
);
CREATE POLICY "messages_update_own" ON public.messages FOR UPDATE USING (sender_id = auth.uid());
CREATE POLICY "messages_delete_own" ON public.messages FOR DELETE USING (sender_id = auth.uid());

-- notifications
CREATE POLICY "notifications_select_own"  ON public.notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "notifications_insert_auth" ON public.notifications FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "notifications_update_own"  ON public.notifications FOR UPDATE USING (user_id = auth.uid());

-- calls
CREATE POLICY "calls_select_member" ON public.calls FOR SELECT USING (
  initiated_by = auth.uid() OR
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = calls.room_id AND user_id = auth.uid())
);
CREATE POLICY "calls_insert_auth"   ON public.calls FOR INSERT WITH CHECK (initiated_by = auth.uid());
CREATE POLICY "calls_update_member" ON public.calls FOR UPDATE USING (
  initiated_by = auth.uid() OR
  EXISTS (SELECT 1 FROM public.room_members WHERE room_id = calls.room_id AND user_id = auth.uid())
);

-- ============================================================
-- 11. REALTIME
-- ============================================================
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;      EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;          EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;       EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;   EXCEPTION WHEN duplicate_object THEN NULL; END;
END;
$$;

-- ============================================================
-- ✅ DONE!
-- Next: Storage → create "avatars" (Public) and "attachments" (Private)
-- ============================================================
