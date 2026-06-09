-- Chạy SQL này trong Supabase SQL Editor của project epqohkagzvboncaciynl
-- (Database → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS pullup_sessions (
    id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    reps         INTEGER     NOT NULL DEFAULT 0,
    duration_sec INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index để query nhanh theo user
CREATE INDEX IF NOT EXISTS idx_pullup_sessions_user_id
    ON pullup_sessions(user_id, created_at DESC);

-- Row Level Security: mỗi user chỉ xem/ghi dữ liệu của mình
ALTER TABLE pullup_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own sessions"
    ON pullup_sessions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sessions"
    ON pullup_sessions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own sessions"
    ON pullup_sessions FOR DELETE
    USING (auth.uid() = user_id);

-- Migration: add exercise_type for multi-exercise support
-- Run this if the column doesn't exist yet:
ALTER TABLE pullup_sessions
ADD COLUMN IF NOT EXISTS exercise_type VARCHAR(50) NOT NULL DEFAULT 'pullup';

CREATE INDEX IF NOT EXISTS idx_pullup_sessions_exercise
    ON pullup_sessions(user_id, exercise_type, created_at DESC);
