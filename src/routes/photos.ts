import { Router } from 'express';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { db } from '../utils/database';
import { Deduplicator } from '../services/deduplicator';

dotenv.config();

interface UserRecord {
  id: string;
  access_token: string;
  refresh_token: string;
  token_expiry: number;
}

const router = Router();

// Middleware to ensure user is authenticated
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Get user's Google Photos REST client
const getPhotosClient = async (userId: string) => {
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

  const baseURL = 'https://photoslibrary.googleapis.com/v1';
  const headers = {
    Authorization: `Bearer ${accessToken}`
  };

  return {
    albums: {
      list: (params: { pageSize?: number; pageToken?: string }) =>
        axios.get(`${baseURL}/albums`, { params, headers }),
      get: ({ albumId }: { albumId: string }) =>
        axios.get(`${baseURL}/albums/${albumId}`, { headers })
    },
    mediaItems: {
      search: ({ requestBody }: { requestBody: any }) =>
        axios.post(`${baseURL}/mediaItems:search`, requestBody, { headers })
    }
  };
};

// List albums
router.get('/albums', requireAuth, async (req, res) => {
  try {
    const photos = await getPhotosClient(req.session.userId!);
    const response = await (photos.albums as any).list({ pageSize: 50 });
    
    res.json({ albums: response.data.albums || [] });
  } catch (error: any) {
    const details = error?.response?.data || error;
    console.error('Error fetching albums:', JSON.stringify(details, null, 2));
    res.status(500).json({
      error: 'Failed to fetch albums',
      details: error?.response?.data || error?.message
    });
  }
});

// Get photos from an album
router.get('/album/:albumId', requireAuth, async (req, res) => {
  const { albumId } = req.params;
  const sessionId = uuidv4();
  
  try {
    const photos = await getPhotosClient(req.session.userId!);
    
    // Get album info
    const albumInfo = await (photos.albums as any).get({ albumId });
    
    // Get photos from album
    let mediaItems: any[] = [];
    let pageToken: string | undefined;
    
    do {
      const response: any = await (photos.mediaItems as any).search({
        requestBody: {
          albumId,
          pageSize: 100,
          pageToken
        }
      });
      
      mediaItems = mediaItems.concat(response.data.mediaItems || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    // Create session
    const database = db.get();
    database.prepare(`
      INSERT INTO sessions (id, user_id, selected_album_id, selected_album_title, photo_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, req.session.userId, albumId, albumInfo.data.title, mediaItems.length);
    
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
        item.productUrl,
        item.baseUrl,
        item.mimeType,
        item.mediaMetadata?.width || 0,
        item.mediaMetadata?.height || 0,
        item.mediaMetadata?.creationTime
      );
    }
    
    res.json({
      sessionId,
      albumTitle: albumInfo.data.title,
      photoCount: mediaItems.length,
      photos: mediaItems.map(p => ({
        id: p.id,
        baseUrl: p.baseUrl,
        mimeType: p.mimeType,
        width: p.mediaMetadata?.width,
        height: p.mediaMetadata?.height,
        creationTime: p.mediaMetadata?.creationTime
      }))
    });
  } catch (error: any) {
    console.error('Error fetching photos:', error?.response?.data || error);
    res.status(500).json({
      error: 'Failed to fetch photos',
      details: error?.response?.data || error?.message
    });
  }
});

// Debug: call Google Photos API directly and return raw response
router.get('/debug/google-albums', requireAuth, async (req, res) => {
  try {
    const photos = await getPhotosClient(req.session.userId!);
    const response = await (photos.albums as any).list({ pageSize: 1 });
    res.json({ ok: true, data: response.data });
  } catch (error: any) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data || error?.message || error;
    res.status(status).json({ ok: false, status, data });
  }
});

// Download and deduplicate photos
router.post('/process', requireAuth, async (req, res) => {
  const { sessionId } = req.body;
  
  try {
    const deduplicator = new Deduplicator();
    const results = await deduplicator.processSessionPhotos(sessionId);
    
    // Calculate required music duration
    const PHOTO_DURATION = parseInt(process.env.PHOTO_DURATION_SECONDS || '4');
    const TRANSITION_DURATION = parseInt(process.env.TRANSITION_DURATION_SECONDS || '1');
    const totalDuration = results.selectedCount * (PHOTO_DURATION + TRANSITION_DURATION);
    
    // Update session
    const database = db.get();
    database.prepare(`
      UPDATE sessions SET music_duration_seconds = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(totalDuration, sessionId);
    
    res.json({
      sessionId,
      originalCount: results.originalCount,
      duplicateCount: results.duplicateCount,
      selectedCount: results.selectedCount,
      requiredMusicMinutes: Math.ceil(totalDuration / 60),
      requiredMusicSeconds: totalDuration
    });
  } catch (error) {
    console.error('Error processing photos:', error);
    res.status(500).json({ error: 'Failed to process photos' });
  }
});

export { router as photosRouter };
