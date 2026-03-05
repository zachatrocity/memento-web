# Memento Web

Create beautiful slideshow videos from your Google Photos with custom music from Plex or uploaded files.

## Features

- **Google Photos Integration**: Select photos directly from your Google Photos library using the official Photos Picker API
- **Plex Music Integration**: Browse and select music from your Plex server
- **Custom Uploads**: Upload your own music files (MP3, WAV, AAC, M4A, FLAC)
- **Automatic Slideshow Generation**: Creates a video with fade transitions between photos
- **Persistent Settings**: Plex and Google auth persist across sessions (30-day sessions)
- **Track Search**: Search for specific tracks in your Plex library

## Prerequisites

- Node.js 18+ 
- FFmpeg installed on your system
- Google OAuth credentials (for Google Photos access)
- Plex account (optional, for Plex music integration)
- Music directory mounted at `/music` (optional, for local music library)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd memento-web
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
# Required: Google OAuth credentials
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback

# Optional: Session secret (generate a random string)
SESSION_SECRET=your_random_session_secret

# Optional: Directories (defaults shown)
DATA_DIR=./data
OUTPUT_DIR=./data/output
UPLOAD_DIR=./data/uploads
MUSIC_DIR=/music

# Optional: Photo/transition durations (seconds)
PHOTO_DURATION_SECONDS=4
TRANSITION_DURATION_SECONDS=1

# Optional: Frontend URL for redirects
FRONTEND_URL=http://localhost:5173
```

4. Set up Google OAuth:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing
   - Enable the **Photos Picker API**
   - Create OAuth 2.0 credentials (Web application type)
   - Add authorized redirect URI: `http://localhost:3000/auth/callback`
   - Copy Client ID and Client Secret to your `.env` file

5. Start the development server:
```bash
npm run dev
```

This starts both the backend (port 3000) and frontend dev server (port 5173).

## Usage

1. Open http://localhost:5173 in your browser
2. Click "Connect Google Photos" to authenticate
3. Select photos from your Google Photos library
4. Add music:
   - **Option A**: Connect Plex and browse your music library
   - **Option B**: Upload music files directly
   - **Option C**: Use music from the mounted `/music` directory
5. Click "Create Video" and wait for processing
6. Download your slideshow video!

## Architecture

- **Backend**: Express.js with TypeScript
- **Database**: SQLite (better-sqlite3)
- **Frontend**: React with Vite
- **Video Processing**: FFmpeg with fluent-ffmpeg
- **Authentication**: 
  - Google OAuth 2.0 (Google Photos)
  - Plex PIN-based auth (Plex Media Server)

## Database Schema

The SQLite database stores:
- **users**: Google auth tokens and user info
- **sessions**: Photo selection sessions
- **photos**: Downloaded photo metadata and paths
- **videos**: Video generation jobs and status
- **user_settings**: Persistent Plex configuration

## Development

### Project Structure
```
memento-web/
├── src/
│   ├── server.ts              # Express server entry
│   ├── routes/
│   │   ├── auth.ts            # Google OAuth routes
│   │   ├── music.ts           # Plex & music upload routes
│   │   ├── photos.ts          # Google Photos Picker API
│   │   ├── settings.ts        # User settings persistence
│   │   └── video.ts           # Video generation routes
│   ├── services/
│   │   └── video-generator.ts # FFmpeg video creation
│   └── utils/
│       └── database.ts        # SQLite setup
├── frontend/
│   └── src/
│       └── App.tsx            # Main React app
└── data/                      # SQLite DB, downloads, uploads, output
```

### Adding Features

The video generation uses a two-pass FFmpeg approach to handle many photos without hitting filtergraph limits:
1. Create individual segments for each photo with fade transitions
2. Concatenate segments and add audio

### Troubleshooting

**Video generation fails with "No such file or directory"**
- Check that all paths in `.env` are absolute or relative to project root
- Ensure `data/` directory exists and is writable

**Plex connection not persisting**
- Make sure you're logged in (Google auth must be active)
- Plex settings are saved per-user in the database

**SQLite errors on startup**
- Delete `node_modules/better-sqlite3` and run `npm install`
- Ensure Node.js version matches the better-sqlite3 binary

## License

MIT

## Contributing

Pull requests welcome! Please ensure:
- TypeScript compiles without errors (`npx tsc --noEmit`)
- Code follows existing patterns
- New features include proper error handling
