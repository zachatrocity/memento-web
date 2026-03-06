# Memento Web

Slideshow videos from Google Photos with music from Plex or uploaded files.

## Features

- **Google Photos Integration**: Select photos using the Google Photos Picker API
- **Plex Music Integration**: Browse and select music from your Plex server
- **Custom Uploads**: Upload music files (MP3, WAV, AAC, M4A, FLAC)
- **Slideshow Generation**: Video with fade transitions between photos
- **Music Duration Tracking**: See how much music you have vs. how much you need
- **Persistent Settings**: Auth and Plex config persist across sessions

## Quick Start (Docker Compose)

The easiest way to run uses the pre-built image from GitHub Container Registry:

```bash
# Create a directory for your installation
mkdir memento-web && cd memento-web

# Download the docker-compose file
curl -O https://raw.githubusercontent.com/zachatrocity/memento-web/main/docker-compose.yml

# Create .env file
cat > .env << 'EOF'
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/callback
SESSION_SECRET=generate-a-random-string
EOF

# Start the container
docker compose up -d
```

The app will be available at `http://localhost:3000` (or your configured domain).

### Docker Compose Configuration

The `docker-compose.yml` sets up:
- Pre-built image with FFmpeg and Node.js (`ghcr.io/zachatrocity/memento-web:latest`)
- Persistent volumes for database, uploads, and output
- Port 3000 exposed

Optional environment variables:
```env
PHOTO_DURATION_SECONDS=4          # Seconds per photo
TRANSITION_DURATION_SECONDS=1     # Transition duration
MUSIC_DIR=/path/to/music          # Host path to music library
```

## Manual Installation

If you prefer not to use Docker:

**Prerequisites:**
- Node.js 18+
- FFmpeg installed on your system

**Steps:**
```bash
npm install
cp .env.example .env
# Edit .env with your Google OAuth credentials
npm run build
npm start
```

## Google OAuth Setup

Required for Google Photos access:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the **Photos Picker API**
4. Create OAuth 2.0 credentials (Web application type)
5. Add authorized redirect URI: `https://your-domain.com/auth/callback`
6. Copy Client ID and Secret to your `.env` file

## Usage

1. Open the app in your browser
2. Click "Connect Google Photos" to authenticate
3. Select photos from your library
4. Add music:
   - Connect Plex and browse your library, or
   - Upload music files directly, or
   - Use music from the mounted `/music` directory
5. Click "Create Video" and wait for processing
6. Download your video

## Architecture

- **Backend**: Express.js with TypeScript
- **Database**: SQLite (better-sqlite3)
- **Frontend**: React with Vite
- **Video Processing**: FFmpeg
- **Authentication**: Google OAuth 2.0, Plex PIN-based auth

## Development

```bash
# Start dev servers (backend + frontend)
npm run dev

# Build for production
npm run build

# Type check
npx tsc --noEmit
```

## Troubleshooting

**SQLite errors on startup**
- Delete `node_modules/better-sqlite3` and run `npm install`
- Ensure Node.js version matches the better-sqlite3 binary

**Video generation fails**
- Check FFmpeg is installed and accessible
- Ensure output directories are writable

**Plex connection not persisting**
- Must be logged in with Google auth (settings are per-user)

## License

MIT
