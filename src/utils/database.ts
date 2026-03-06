import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'memento.db');

let dbInstance: Database.Database | null = null;

export const db = {
  init: () => {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    dbInstance = new Database(DB_PATH);
    
    // Create tables
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_id TEXT UNIQUE,
        email TEXT,
        name TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expiry INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        status TEXT DEFAULT 'active',
        selected_album_id TEXT,
        selected_album_title TEXT,
        photo_count INTEGER,
        music_duration_seconds INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        google_photo_id TEXT,
        url TEXT,
        base_url TEXT,
        mime_type TEXT,
        media_type TEXT DEFAULT 'photo',
        width INTEGER,
        height INTEGER,
        file_size INTEGER,
        duration_seconds REAL,
        creation_time TEXT,
        is_dupe INTEGER DEFAULT 0,
        dupe_group_id TEXT,
        is_selected INTEGER DEFAULT 1,
        blur_score REAL,
        sharpness_score REAL,
        downloaded_path TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT DEFAULT 'pending',
        output_path TEXT,
        duration_seconds INTEGER,
        file_size INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        plex_auth_token TEXT,
        plex_client_id TEXT,
        plex_server_id TEXT,
        plex_server_name TEXT,
        plex_server_uri TEXT,
        plex_server_token TEXT,
        plex_library_id TEXT,
        plex_library_title TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    console.log('📊 Database initialized at', DB_PATH);
  },

  get: () => {
    if (!dbInstance) throw new Error('Database not initialized');
    return dbInstance;
    }
};
