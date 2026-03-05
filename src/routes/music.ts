import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db } from '../utils/database';

const router = Router();

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

// Get audio duration (simplified - in real app use music-metadata)
router.post('/durations', async (req, res) => {
  const { files } = req.body; // Array of file paths
  
  // For now, estimate based on file size (rough approximation)
  // In production, use music-metadata npm package for accurate duration
  const results = files.map((file: string) => ({
    path: file,
    // Rough estimate: 1MB ≈ 1 minute for MP3
    estimatedDuration: 60 
  }));
  
  res.json({ durations: results });
});

export { router as musicRouter };
