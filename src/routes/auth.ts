import dotenv from 'dotenv';
import { Router } from 'express';
import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../utils/database';
dotenv.config();

interface UserRecord {
  id: string;
  google_id: string;
  email: string;
  name: string;
  access_token: string;
  refresh_token: string;
  token_expiry: number;
}

const router = Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/callback'
);

// Scopes needed for Google Photos
const SCOPES = [
  // Use readonly Photos scope (non-restricted) for unverified apps
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

// Get auth URL
router.get('/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Force to get refresh token
  });
  res.json({ url });
});

// OAuth callback
router.get('/callback', async (req, res) => {
  const code = req.query.code as string;
  
  if (!code) {
    return res.status(400).json({ error: 'Authorization code required' });
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();

    const userId = uuidv4();
    const database = db.get();

    // Check if user exists
    const existingUser = database.prepare(
      'SELECT * FROM users WHERE google_id = ?'
    ).get(userInfo.data.id) as UserRecord | undefined;

    if (existingUser) {
      // Update tokens
      database.prepare(`
        UPDATE users 
        SET access_token = ?, refresh_token = ?, token_expiry = ?
        WHERE google_id = ?
      `).run(
        tokens.access_token,
        tokens.refresh_token || existingUser.refresh_token,
        tokens.expiry_date,
        userInfo.data.id
      );
      
      req.session.userId = existingUser.id;
    } else {
      // Create new user
      database.prepare(`
        INSERT INTO users (id, google_id, email, name, access_token, refresh_token, token_expiry)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        userInfo.data.id,
        userInfo.data.email,
        userInfo.data.name,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date
      );
      
      req.session.userId = userId;
    }

    req.session.save(() => {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      res.redirect(`${frontendUrl}/?auth=success`);
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('/?auth=error&message=' + encodeURIComponent((error as Error).message));
  }
});

// Check auth status
router.get('/status', (req, res) => {
  if (req.session.userId) {
    const database = db.get();
    const user = database.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.session.userId) as { id: string; email: string; name: string } | undefined;
    res.json({ authenticated: true, user });
  } else {
    res.json({ authenticated: false });
  }
});

// Debug: show tokeninfo scopes
router.get('/tokeninfo', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const database = db.get();
  const user = database.prepare('SELECT access_token FROM users WHERE id = ?').get(req.session.userId) as { access_token: string } | undefined;
  if (!user?.access_token) return res.status(404).json({ error: 'No token found' });
  try {
    const tokenInfo = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${user.access_token}`);
    const data = await tokenInfo.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tokeninfo', details: String(err) });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

export { router as authRouter };
