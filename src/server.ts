import express from 'express';
import session from 'express-session';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { authRouter } from './routes/auth';
import { photosRouter } from './routes/photos';
import { musicRouter } from './routes/music';
import { videoRouter } from './routes/video';
import { settingsRouter } from './routes/settings';
import { db } from './utils/database';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for secure cookies behind HTTPS terminator
app.set('trust proxy', 1);

// Initialize database
db.init();

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'development-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

// Static files - serve uploaded music and generated videos
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));
app.use('/output', express.static(path.join(__dirname, '../data/output')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/auth', authRouter);
app.use('/api/photos', photosRouter);
app.use('/api/music', musicRouter);
app.use('/api/video', videoRouter);
app.use('/api/settings', settingsRouter);

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/build/index.html'));
  });
} else {
  // In dev, redirect to assumed dev server
  app.get('/', (req, res) => {
    res.redirect('http://localhost:5173');
  });
}

app.listen(PORT, () => {
  console.log(`🎬 Memento Web server running on port ${PORT}`);
  console.log(`📁 Output directory: ${process.env.OUTPUT_DIR || './data/output'}`);
  console.log(`🎵 Music directory: ${process.env.MUSIC_DIR || '/music'}`);
});
