import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db } from '../utils/database';

interface PlexSession {
  authToken?: string;
  clientId?: string;
  serverId?: string;
  serverName?: string;
  serverUri?: string;
  serverToken?: string;
  libraryId?: string;
  libraryTitle?: string;
}

const router = Router();

const PLEX_PRODUCT = 'Memento Web';
const PLEX_PLATFORM = 'Web';
const PLEX_DEVICE = 'Memento';
const PLEX_VERSION = '1.0';

function getPlexSession(req: any): PlexSession {
  if (!req.session.plex) req.session.plex = {};
  return req.session.plex as PlexSession;
}

function plexHeaders(clientId: string, token?: string) {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Platform': PLEX_PLATFORM,
    'X-Plex-Device': PLEX_DEVICE,
    'X-Plex-Version': PLEX_VERSION
  };
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads');
const MUSIC_DIR = process.env.MUSIC_DIR || '/music';

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer config for music uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/aac',
      'audio/mp4',
      'audio/flac'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  }
});

// Get music from mounted volume
router.get('/library', (req, res) => {
  const musicFiles: Array<{ name: string; path: string; size: number; duration?: number }> = [];
  
  function scanDir(dir: string, basePath: string = '') {
    if (!fs.existsSync(dir)) return;
    
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDir(fullPath, path.join(basePath, file));
      } else if (/\.(mp3|wav|aac|m4a|flac)$/i.test(file)) {
        musicFiles.push({
          name: file,
          path: path.join(basePath, file).replace(/\\/g, '/'),
          size: stat.size
        });
      }
    }
  }
  
  scanDir(MUSIC_DIR);
  res.json({ files: musicFiles });
});

// Plex: start PIN auth
router.post('/plex/pin', async (req, res) => {
  try {
    const session = getPlexSession(req);
    const clientId = session.clientId || `memento-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    session.clientId = clientId;

    const pinRes = await fetch('https://plex.tv/api/v2/pins?strong=true', {
      method: 'POST',
      headers: plexHeaders(clientId)
    });
    const pinData = await pinRes.json() as { id: number; code: string };

    const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(pinData.code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PLEX_PRODUCT)}&context%5Bdevice%5D%5Bplatform%5D=${encodeURIComponent(PLEX_PLATFORM)}&context%5Bdevice%5D%5BdeviceName%5D=${encodeURIComponent(PLEX_DEVICE)}`;

    res.json({ authUrl, pinId: pinData.id });
  } catch (err) {
    console.error('Plex PIN start failed:', err);
    res.status(500).json({ error: 'Failed to start Plex auth' });
  }
});

// Plex: poll PIN status
router.get('/plex/pin/:pinId', async (req, res) => {
  try {
    const session = getPlexSession(req);
    if (!session.clientId) return res.status(400).json({ error: 'Missing Plex client' });

    const pinId = req.params.pinId;
    const pinRes = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: plexHeaders(session.clientId)
    });
    const pinData = await pinRes.json() as { authToken?: string };

    if (pinData.authToken) {
      session.authToken = pinData.authToken;
      
      // Save to persistent settings if user is authenticated
      if (req.session.userId) {
        const database = db.get();
        const existing = database.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(req.session.userId);
        if (existing) {
          database.prepare('UPDATE user_settings SET plex_auth_token = ?, plex_client_id = ? WHERE user_id = ?')
            .run(pinData.authToken, session.clientId, req.session.userId);
        } else {
          database.prepare('INSERT INTO user_settings (user_id, plex_auth_token, plex_client_id) VALUES (?, ?, ?)')
            .run(req.session.userId, pinData.authToken, session.clientId);
        }
      }
    }

    res.json({ authenticated: !!pinData.authToken });
  } catch (err) {
    console.error('Plex PIN poll failed:', err);
    res.status(500).json({ error: 'Failed to poll Plex PIN' });
  }
});

// Plex: status
router.get('/plex/status', (req, res) => {
  const session = getPlexSession(req);
  res.json({
    authenticated: !!session.authToken,
    serverId: session.serverId,
    serverName: session.serverName,
    libraryId: session.libraryId,
    libraryTitle: session.libraryTitle
  });
});

// Plex: list servers
router.get('/plex/servers', async (req, res) => {
  try {
    const session = getPlexSession(req);
    if (!session.authToken || !session.clientId) {
      return res.status(401).json({ error: 'Plex authentication required' });
    }

    const resourcesRes = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
      headers: plexHeaders(session.clientId, session.authToken)
    });
    const resources = await resourcesRes.json() as any[];

    const servers = resources
      .filter(r => r.provides?.includes('server'))
      .map(r => {
        const connections = r.connections || [];
        // Prefer relay (works from anywhere), then HTTPS direct, then HTTP
        const connection = 
          connections.find((c: any) => c.relay) ||
          connections.find((c: any) => c.uri?.startsWith('https://')) ||
          connections[0];
        return {
          id: r.clientIdentifier,
          name: r.name,
          uri: connection?.uri,
          token: r.accessToken
        };
      })
      .filter(r => r.uri && r.token);

    res.json({ servers });
  } catch (err) {
    console.error('Plex servers failed:', err);
    res.status(500).json({ error: 'Failed to load Plex servers' });
  }
});

// Plex: select server
router.post('/plex/servers/select', async (req, res) => {
  const { serverId, serverName, serverUri, serverToken } = req.body || {};
  if (!serverId || !serverUri || !serverToken) {
    return res.status(400).json({ error: 'Server details required' });
  }
  const session = getPlexSession(req);
  session.serverId = serverId;
  session.serverName = serverName;
  session.serverUri = serverUri;
  session.serverToken = serverToken;
  session.libraryId = undefined;
  session.libraryTitle = undefined;
  
  // Persist to database
  if (req.session.userId) {
    try {
      const database = db.get();
      const existing = database.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(req.session.userId);
      if (existing) {
        database.prepare(`
          UPDATE user_settings SET 
            plex_server_id = ?, plex_server_name = ?, plex_server_uri = ?, plex_server_token = ?,
            plex_library_id = NULL, plex_library_title = NULL
          WHERE user_id = ?
        `).run(serverId, serverName, serverUri, serverToken, req.session.userId);
      } else {
        database.prepare(`
          INSERT INTO user_settings 
            (user_id, plex_server_id, plex_server_name, plex_server_uri, plex_server_token, plex_auth_token, plex_client_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(req.session.userId, serverId, serverName, serverUri, serverToken, session.authToken, session.clientId);
      }
    } catch (err) {
      console.error('Failed to persist server selection:', err);
    }
  }
  
  res.json({ success: true });
});

// Plex: list libraries
router.get('/plex/libraries', async (req, res) => {
  try {
    const session = getPlexSession(req);
    if (!session.serverUri || !session.serverToken || !session.clientId) {
      return res.status(400).json({ error: 'Plex server not selected' });
    }

    const librariesRes = await fetch(`${session.serverUri}/library/sections`, {
      headers: plexHeaders(session.clientId, session.serverToken)
    });
    const data = await librariesRes.json() as any;
    const libraries = (data.MediaContainer?.Directory || [])
      .filter((d: any) => d.type === 'artist' || d.type === 'music')
      .map((d: any) => ({ id: d.key, title: d.title }));

    res.json({ libraries });
  } catch (err) {
    console.error('Plex libraries failed:', err);
    res.status(500).json({ error: 'Failed to load Plex libraries' });
  }
});

// Plex: select library
router.post('/plex/libraries/select', async (req, res) => {
  const { libraryId, libraryTitle } = req.body || {};
  if (!libraryId) return res.status(400).json({ error: 'Library required' });
  const session = getPlexSession(req);
  session.libraryId = libraryId;
  session.libraryTitle = libraryTitle;
  
  // Persist to database
  if (req.session.userId) {
    try {
      const database = db.get();
      database.prepare(`
        UPDATE user_settings SET 
          plex_library_id = ?, plex_library_title = ?
        WHERE user_id = ?
      `).run(libraryId, libraryTitle, req.session.userId);
    } catch (err) {
      console.error('Failed to persist library selection:', err);
    }
  }
  
  res.json({ success: true });
});

// Plex: list tracks in selected library
router.get('/plex/library/:libraryId/tracks', async (req, res) => {
  try {
    const session = getPlexSession(req);
    if (!session.serverUri || !session.serverToken || !session.clientId) {
      return res.status(400).json({ error: 'Plex server not selected' });
    }

    const libraryId = req.params.libraryId;
    const limit = Math.min(parseInt(req.query.limit as string || '500', 10), 1000);
    const searchQuery = req.query.search as string;
    
    let tracks: any[] = [];
    
    if (searchQuery && searchQuery.trim()) {
      // Use Plex's universal search for better results across title and artist
      // This searches the entire library for matching tracks
      const searchUrl = `${session.serverUri}/library/sections/${libraryId}/search?type=10&query=${encodeURIComponent(searchQuery)}&X-Plex-Container-Size=${limit}`;
      
      const searchRes = await fetch(searchUrl, {
        headers: plexHeaders(session.clientId, session.serverToken)
      });
      const searchData = await searchRes.json() as any;
      tracks = (searchData.MediaContainer?.Metadata || []).map((t: any) => ({
        ratingKey: t.ratingKey,
        title: t.title,
        artist: t.grandparentTitle || t.originalTitle || t.artist || '',
        duration: t.duration
      }));
    } else {
      // No search query - list all tracks
      let url = `${session.serverUri}/library/sections/${libraryId}/all?type=10&X-Plex-Container-Size=${limit}`;
      
      const tracksRes = await fetch(url, {
        headers: plexHeaders(session.clientId, session.serverToken)
      });
      const data = await tracksRes.json() as any;
      tracks = (data.MediaContainer?.Metadata || []).map((t: any) => ({
        ratingKey: t.ratingKey,
        title: t.title,
        artist: t.grandparentTitle || t.originalTitle || t.artist || '',
        duration: t.duration
      }));
    }

    // Client-side filtering for additional safety (search in both title and artist)
    if (searchQuery && searchQuery.trim()) {
      const searchLower = searchQuery.toLowerCase().trim();
      tracks = tracks.filter((t: any) => 
        t.title.toLowerCase().includes(searchLower) || 
        t.artist.toLowerCase().includes(searchLower)
      );
    }

    res.json({ tracks });
  } catch (err) {
    console.error('Plex tracks failed:', err);
    res.status(500).json({ error: 'Failed to load Plex tracks' });
  }
});

// Upload music
router.post('/upload', upload.array('music', 10), (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  
  res.json({
    success: true,
    files: files.map(f => ({
      name: f.originalname,
      path: f.filename,
      size: f.size
    }))
  });
});

// Get uploaded music
router.get('/uploaded', (req, res) => {
  if (!fs.existsSync(UPLOAD_DIR)) {
    return res.json({ files: [] });
  }
  
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => /\.(mp3|wav|aac|m4a|flac)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        name: f,
        path: f,
        size: stat.size
      };
    });
  
  res.json({ files });
});

// Delete uploaded music
router.delete('/uploaded/:filename', (req, res) => {
  const { filename } = req.params;
  const filepath = path.join(UPLOAD_DIR, filename);
  
  if (!filepath.startsWith(UPLOAD_DIR)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Get audio duration for multiple files (Plex tracks and uploaded files)
router.post('/durations', async (req, res) => {
  const { files, plex } = req.body; // files: Array of file paths/plex keys, plex: optional plex config
  const session = getPlexSession(req);
  
  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ error: 'Files array required' });
  }
  
  const results: Array<{ path: string; duration: number; found: boolean }> = [];
  let totalDuration = 0;
  
  for (const file of files) {
    try {
      if (file.startsWith('plex:')) {
        // Get duration from Plex metadata
        if (!session.serverUri || !session.serverToken) {
          results.push({ path: file, duration: 0, found: false });
          continue;
        }
        const ratingKey = file.replace('plex:', '');
        const metaRes = await fetch(`${session.serverUri}/library/metadata/${ratingKey}`, {
          headers: plexHeaders(session.clientId || '', session.serverToken)
        });
        const meta = await metaRes.json() as any;
        const track = meta.MediaContainer?.Metadata?.[0];
        // Plex duration is in milliseconds
        const duration = track?.duration ? Math.round(track.duration / 1000) : 0;
        results.push({ path: file, duration, found: duration > 0 });
        totalDuration += duration;
      } else {
        // Get duration from local file using ffprobe
        const filePath = path.join(UPLOAD_DIR, file);
        const finalPath = fs.existsSync(filePath) ? filePath : path.join(MUSIC_DIR, file);
        
        if (!fs.existsSync(finalPath)) {
          results.push({ path: file, duration: 0, found: false });
          continue;
        }
        
        const duration = await getLocalAudioDuration(finalPath);
        results.push({ path: file, duration, found: duration > 0 });
        totalDuration += duration;
      }
    } catch (err) {
      console.error(`Failed to get duration for ${file}:`, err);
      results.push({ path: file, duration: 0, found: false });
    }
  }
  
  res.json({ 
    durations: results, 
    totalDuration,
    totalDurationMinutes: Math.round(totalDuration / 60 * 10) / 10 // Round to 1 decimal
  });
});

// Helper function to get audio duration using ffprobe
function getLocalAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('fluent-ffmpeg');
    ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
  });
}

export { router as musicRouter };
