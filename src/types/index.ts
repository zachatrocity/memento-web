import 'express-session';
import { Database } from 'better-sqlite3';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    user?: {
      id: string;
      email: string;
      name?: string;
      access_token?: string;
      refresh_token?: string;
      token_expiry?: number;
    };
  }
}

export interface VideoRecord {
  id: string;
  session_id: string;
  user_id: string;
  status: string;
  output_path: string | null;
  duration_seconds: number | null;
  file_size: number | null;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  status: string;
  selected_album_id: string | null;
  selected_album_title: string | null;
  photo_count: number;
  music_duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}
