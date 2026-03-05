import { Router } from 'express';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { db } from '../utils/database';

dotenv.config();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../../data/downloads');

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

interface UserRecord {
  id: string;
  access_token: string;
  refresh_token: string;
  token_expiry: number;
}

interface PickerSession {
  id: string;
  pickerUri: string;
  pollingConfig?: {
    pollInterval: string;
    timeoutIn: string;
  };
  mediaItemsSet?: boolean;
}

interface PickerMediaItem {
  id: string;
  type: string;
  mediaFile?: {
    baseUrl: string;
    mimeType: string;
    filename: string;
  };
}

interface PhotoRecord {
  id: string;
  base_url: string;
}

const router = Router();

// Middleware to ensure user is authenticated
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Get access token for user, refreshing if needed
const getAccessToken = async (userId: string): Promise<string> => {
  const database = db.get();
  const user = database.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRecord | undefined;

  if (!user) throw new Error('User not found');

  const now = Date.now();
  let accessToken = user.access_token;

  // Refresh access token if expired/near-expiry
  if (user.refresh_token && user.token_expiry && user.token_expiry < now + 60 * 1000) {
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: user.refresh_token,
        grant_type: 'refresh_token'
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    accessToken = tokenRes.data.access_token;
    const expiresIn = tokenRes.data.expires_in || 3600;
    const newExpiry = now + expiresIn * 1000;

    database.prepare(`
      UPDATE users SET access_token = ?, token_expiry = ? WHERE id = ?
    `).run(accessToken, newExpiry, userId);
  }

  return accessToken;
};

// Download a single photo
const downloadPhoto = async (photo: PhotoRecord, accessToken: string): Promise<string> => {
  const filename = `${photo.id}.jpg`;
  const filepath = path.join(DOWNLOAD_DIR, filename);
  
  if (fs.existsSync(filepath)) {
    return filepath;
  }
  
  // Build download URL - append =d for full resolution download
  let downloadUrl = photo.base_url;
  if (downloadUrl.includes('googleusercontent.com')) {
    downloadUrl = downloadUrl.split('=')[0] + '=d';
  }
  
  const response = await axios.get(downloadUrl, { 
    responseType: 'stream',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
  
  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);
  
  await new Promise<void>((resolve, reject) => {
    writer.on('finish', () => resolve());
    writer.on('error', reject);
  });
  
  return filepath;
};

// Create a new Photos Picker session
router.post('/picker/session', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken(req.session.userId!);
    
    const response = await axios.post<PickerSession>(
      'https://photospicker.googleapis.com/v1/sessions',
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      sessionId: response.data.id,
      pickerUrl: response.data.pickerUri,
      pollingConfig: response.data.pollingConfig
    });
  } catch (error: any) {
    const details = error?.response?.data || error;
    console.error('Error creating picker session:', JSON.stringify(details, null, 2));
    res.status(error?.response?.status || 500).json({
      error: 'Failed to create picker session',
      details: error?.response?.data || error?.message
    });
  }
});

// Poll a picker session to check if user has selected photos
router.get('/picker/session/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const accessToken = await getAccessToken(req.session.userId!);
    
    const response = await axios.get<PickerSession>(
      `https://photospicker.googleapis.com/v1/sessions/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    res.json({
      sessionId: response.data.id,
      pickerUrl: response.data.pickerUri,
      mediaItemsSet: response.data.mediaItemsSet || false,
      pollingConfig: response.data.pollingConfig
    });
  } catch (error: any) {
    const details = error?.response?.data || error;
    console.error('Error polling picker session:', JSON.stringify(details, null, 2));
    res.status(error?.response?.status || 500).json({
      error: 'Failed to poll picker session',
      details: error?.response?.data || error?.message
    });
  }
});

// Get media items from a completed picker session
router.get('/picker/session/:sessionId/items', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const pageToken = req.query.pageToken as string | undefined;
  
  try {
    const accessToken = await getAccessToken(req.session.userId!);
    
    const url = new URL(`https://photospicker.googleapis.com/v1/mediaItems`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('pageSize', '100');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    
    const response = await axios.get(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    res.json({
      mediaItems: response.data.mediaItems || [],
      nextPageToken: response.data.nextPageToken
    });
  } catch (error: any) {
    const details = error?.response?.data || error;
    console.error('Error fetching picker media items:', JSON.stringify(details, null, 2));
    res.status(error?.response?.status || 500).json({
      error: 'Failed to fetch media items',
      details: error?.response?.data || error?.message
    });
  }
});

// Delete a picker session when done
router.delete('/picker/session/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const accessToken = await getAccessToken(req.session.userId!);
    
    await axios.delete(
      `https://photospicker.googleapis.com/v1/sessions/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    res.json({ success: true });
  } catch (error: any) {
    const details = error?.response?.data || error;
    console.error('Error deleting picker session:', JSON.stringify(details, null, 2));
    res.status(error?.response?.status || 500).json({
      error: 'Failed to delete picker session',
      details: error?.response?.data || error?.message
    });
  }
});

// Import photos from a completed picker session into our database
router.post('/picker/import', requireAuth, async (req, res) => {
  const { pickerSessionId } = req.body;
  
  if (!pickerSessionId) {
    return res.status(400).json({ error: 'pickerSessionId is required' });
  }
  
  const sessionId = uuidv4();
  
  try {
    const accessToken = await getAccessToken(req.session.userId!);
    
    // Fetch all media items from the picker session
    let mediaItems: PickerMediaItem[] = [];
    let pageToken: string | undefined;
    
    do {
      const url = new URL(`https://photospicker.googleapis.com/v1/mediaItems`);
      url.searchParams.set('sessionId', pickerSessionId);
      url.searchParams.set('pageSize', '100');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }
      
      const response = await axios.get(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      
      mediaItems = mediaItems.concat(response.data.mediaItems || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    // Create session in database
    const database = db.get();
    database.prepare(`
      INSERT INTO sessions (id, user_id, selected_album_id, selected_album_title, photo_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, req.session.userId, pickerSessionId, 'Selected Photos', mediaItems.length);
    
    // Store photos in database
    const insertPhoto = database.prepare(`
      INSERT INTO photos (id, session_id, google_photo_id, url, base_url, mime_type, width, height, creation_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const item of mediaItems) {
      insertPhoto.run(
        uuidv4(),
        sessionId,
        item.id,
        item.mediaFile?.baseUrl || '',
        item.mediaFile?.baseUrl || '',
        item.mediaFile?.mimeType || 'image/jpeg',
        0,
        0,
        null
      );
    }
    
    res.json({
      sessionId,
      photoCount: mediaItems.length,
      photos: mediaItems.map(p => ({
        id: p.id,
        baseUrl: p.mediaFile?.baseUrl,
        mimeType: p.mediaFile?.mimeType,
        filename: p.mediaFile?.filename
      }))
    });
  } catch (error: any) {
    console.error('Error importing photos:', error?.response?.data || error);
    res.status(500).json({
      error: 'Failed to import photos',
      details: error?.response?.data || error?.message
    });
  }
});

// Process photos - download all photos for video generation (no deduplication)
router.post('/process', requireAuth, async (req, res) => {
  const { sessionId } = req.body;
  
  try {
    const accessToken = await getAccessToken(req.session.userId!);
    const database = db.get();
    
    // Get photos for this session
    const photos = database.prepare(
      'SELECT id, base_url FROM photos WHERE session_id = ?'
    ).all(sessionId) as PhotoRecord[];

    console.log(`Processing ${photos.length} photos for session ${sessionId}`);
    
    const updatePhoto = database.prepare(`
      UPDATE photos SET is_selected = 1, is_dupe = 0 WHERE id = ?
    `);
    
    const updateDownloadPath = database.prepare(`
      UPDATE photos SET downloaded_path = ? WHERE id = ?
    `);

    let downloadedCount = 0;
    for (const photo of photos) {
      updatePhoto.run(photo.id);
      
      if (photo.base_url && photo.base_url.length > 0) {
        try {
          const downloadPath = await downloadPhoto(photo, accessToken);
          updateDownloadPath.run(downloadPath, photo.id);
          downloadedCount++;
          console.log(`Downloaded photo ${downloadedCount}/${photos.length}`);
        } catch (error) {
          console.error(`Failed to download photo ${photo.id}:`, error);
        }
      }
    }

    console.log(`Downloaded ${downloadedCount} of ${photos.length} photos`);
    
    // Calculate required music duration
    const PHOTO_DURATION = parseInt(process.env.PHOTO_DURATION_SECONDS || '4');
    const TRANSITION_DURATION = parseInt(process.env.TRANSITION_DURATION_SECONDS || '1');
    const totalDuration = photos.length * (PHOTO_DURATION + TRANSITION_DURATION);
    
    // Update session
    database.prepare(`
      UPDATE sessions SET music_duration_seconds = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(totalDuration, sessionId);
    
    res.json({
      sessionId,
      originalCount: photos.length,
      duplicateCount: 0,
      selectedCount: photos.length,
      requiredMusicMinutes: Math.ceil(totalDuration / 60),
      requiredMusicSeconds: totalDuration
    });
  } catch (error) {
    console.error('Error processing photos:', error);
    res.status(500).json({ error: 'Failed to process photos' });
  }
});

// ============================================
// LEGACY ENDPOINTS (deprecated)
// ============================================

router.get('/albums', requireAuth, async (req, res) => {
  res.status(410).json({
    error: 'This endpoint is deprecated',
    message: 'The Google Photos Library API was deprecated on March 31, 2025. Please use the Picker API instead.',
  });
});

router.get('/album/:albumId', requireAuth, async (req, res) => {
  res.status(410).json({
    error: 'This endpoint is deprecated',
    message: 'The Google Photos Library API was deprecated on March 31, 2025. Please use the Picker API instead.',
  });
});

export { router as photosRouter };
