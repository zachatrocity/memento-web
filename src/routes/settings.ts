import { Router } from 'express';
import { db } from '../utils/database';

const router = Router();

interface UserSettings {
  plex_auth_token?: string;
  plex_client_id?: string;
  plex_server_id?: string;
  plex_server_name?: string;
  plex_server_uri?: string;
  plex_server_token?: string;
  plex_library_id?: string;
  plex_library_title?: string;
}

// Middleware to ensure user is authenticated
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Get user settings
router.get('/', requireAuth, (req, res) => {
  try {
    const database = db.get();
    const settings = database.prepare(
      'SELECT * FROM user_settings WHERE user_id = ?'
    ).get(req.session.userId) as UserSettings | undefined;

    res.json({
      plex: settings ? {
        authenticated: !!settings.plex_auth_token,
        serverId: settings.plex_server_id,
        serverName: settings.plex_server_name,
        serverUri: settings.plex_server_uri,
        libraryId: settings.plex_library_id,
        libraryTitle: settings.plex_library_title
      } : null
    });
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Save Plex settings
router.post('/plex', requireAuth, (req, res) => {
  try {
    const { authToken, clientId, serverId, serverName, serverUri, serverToken, libraryId, libraryTitle } = req.body;
    const database = db.get();

    // Check if settings exist
    const existing = database.prepare(
      'SELECT user_id FROM user_settings WHERE user_id = ?'
    ).get(req.session.userId);

    if (existing) {
      database.prepare(`
        UPDATE user_settings SET
          plex_auth_token = COALESCE(?, plex_auth_token),
          plex_client_id = COALESCE(?, plex_client_id),
          plex_server_id = COALESCE(?, plex_server_id),
          plex_server_name = COALESCE(?, plex_server_name),
          plex_server_uri = COALESCE(?, plex_server_uri),
          plex_server_token = COALESCE(?, plex_server_token),
          plex_library_id = COALESCE(?, plex_library_id),
          plex_library_title = COALESCE(?, plex_library_title),
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(
        authToken, clientId, serverId, serverName, serverUri, serverToken,
        libraryId, libraryTitle, req.session.userId
      );
    } else {
      database.prepare(`
        INSERT INTO user_settings (
          user_id, plex_auth_token, plex_client_id, plex_server_id,
          plex_server_name, plex_server_uri, plex_server_token,
          plex_library_id, plex_library_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.session.userId, authToken, clientId, serverId, serverName,
        serverUri, serverToken, libraryId, libraryTitle
      );
    }

    // Also update session for immediate use
    if (!req.session.plex) req.session.plex = {};
    if (authToken) req.session.plex.authToken = authToken;
    if (clientId) req.session.plex.clientId = clientId;
    if (serverId) req.session.plex.serverId = serverId;
    if (serverName) req.session.plex.serverName = serverName;
    if (serverUri) req.session.plex.serverUri = serverUri;
    if (serverToken) req.session.plex.serverToken = serverToken;
    if (libraryId) req.session.plex.libraryId = libraryId;
    if (libraryTitle) req.session.plex.libraryTitle = libraryTitle;

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving Plex settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Clear Plex settings
router.delete('/plex', requireAuth, (req, res) => {
  try {
    const database = db.get();
    database.prepare('DELETE FROM user_settings WHERE user_id = ?').run(req.session.userId);
    
    // Clear session
    req.session.plex = {};
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing Plex settings:', error);
    res.status(500).json({ error: 'Failed to clear settings' });
  }
});

// Load settings into session (called on auth check)
router.post('/load', requireAuth, (req, res) => {
  try {
    const database = db.get();
    const settings = database.prepare(
      'SELECT * FROM user_settings WHERE user_id = ?'
    ).get(req.session.userId) as any;

    if (settings) {
      req.session.plex = {
        authToken: settings.plex_auth_token,
        clientId: settings.plex_client_id,
        serverId: settings.plex_server_id,
        serverName: settings.plex_server_name,
        serverUri: settings.plex_server_uri,
        serverToken: settings.plex_server_token,
        libraryId: settings.plex_library_id,
        libraryTitle: settings.plex_library_title
      };
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error loading settings:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

export { router as settingsRouter };
