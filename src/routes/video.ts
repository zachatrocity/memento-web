import { Router } from 'express';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../utils/database';
import { videoGenerator } from '../services/video-generator';
import type { VideoRecord } from '../types';

interface SessionRecord {
  user_id: string;
}

const router = Router();
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '../../data/output');

// Middleware to ensure user is authenticated
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Create video
router.post('/create', requireAuth, async (req, res) => {
  const { sessionId, musicFiles } = req.body;
  
  if (!sessionId || !musicFiles || musicFiles.length === 0) {
    return res.status(400).json({ error: 'Session ID and music files required' });
  }
  
  try {
    // Verify session belongs to user
    const database = db.get();
    const session = database.prepare(
      'SELECT * FROM sessions WHERE id = ? AND user_id = ?'
    ).get(sessionId, req.session.userId) as { id: string } | undefined;
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const videoId = uuidv4();
    
    // Start video generation (don't await, run in background)
    const plex = req.session.plex && req.session.plex.serverUri && req.session.plex.serverToken
      ? {
          serverUri: req.session.plex.serverUri,
          token: req.session.plex.serverToken,
          clientId: req.session.plex.clientId
        }
      : undefined;

    videoGenerator.createVideo({
      sessionId,
      musicFiles,
      videoId,
      plex,
      onProgress: (progress) => {
        console.log(`Video ${videoId} progress: ${progress}%`);
      },
      onComplete: (outputPath) => {
        console.log(`Video ${videoId} complete:`, outputPath);
      },
      onError: (error) => {
        console.error(`Video ${videoId} error:`, error);
      }
    }).catch(err => {
      console.error('Video generation failed:', err);
    });
    
    res.json({
      success: true,
      videoId,
      status: 'processing',
      message: 'Video generation started'
    });
  } catch (error) {
    console.error('Error starting video creation:', error);
    res.status(500).json({ error: 'Failed to start video creation' });
  }
});

// Get video status
router.get('/status/:videoId', requireAuth, async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const database = db.get();
    const video = database.prepare(
      'SELECT * FROM videos WHERE id = ?'
    ).get(videoId) as VideoRecord | undefined;
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Verify ownership through session
    const session = database.prepare(
      'SELECT user_id FROM sessions WHERE id = ?'
    ).get(video.session_id) as SessionRecord | undefined;
    
    if (!session || session.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    res.json({
      id: video.id,
      status: video.status,
      fileSize: video.file_size,
      duration: video.duration_seconds,
      createdAt: video.created_at,
      errorMessage: video.status === 'error' ? (video as any).error_message : undefined,
      downloadUrl: video.status === 'complete' && video.output_path ? `/output/${path.basename(video.output_path)}` : null
    });
  } catch (error) {
    console.error('Error getting video status:', error);
    res.status(500).json({ error: 'Failed to get video status' });
  }
});

// List user's videos
router.get('/list', requireAuth, async (req, res) => {
  try {
    const database = db.get();
    const videos = database.prepare(`
      SELECT v.*, s.selected_album_title 
      FROM videos v
      JOIN sessions s ON v.session_id = s.id
      WHERE s.user_id = ?
      ORDER BY v.created_at DESC
    `).all(req.session.userId) as (VideoRecord & { selected_album_title: string })[];
    
    res.json({
      videos: videos.map(v => ({
        id: v.id,
        status: v.status,
        albumTitle: v.selected_album_title,
        fileSize: v.file_size,
        createdAt: v.created_at,
        downloadUrl: v.status === 'complete' && v.output_path ? `/output/${path.basename(v.output_path)}` : null
      }))
    });
  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

// Delete video
router.delete('/:videoId', requireAuth, async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const database = db.get();
    const video = database.prepare(
      'SELECT v.*, s.user_id FROM videos v JOIN sessions s ON v.session_id = s.id WHERE v.id = ?'
    ).get(videoId) as (VideoRecord & { user_id: string }) | undefined;
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    if (video.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Delete file
    if (video.output_path && video.status === 'complete') {
      try {
        const fs = await import('fs');
        if (fs.existsSync(video.output_path)) {
          fs.unlinkSync(video.output_path);
        }
      } catch (err) {
        console.error('Error deleting video file:', err);
      }
    }
    
    // Delete from database
    database.prepare('DELETE FROM videos WHERE id = ?').run(videoId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

export { router as videoRouter };
