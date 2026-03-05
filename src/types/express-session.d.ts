import 'express-session';

declare module 'express-session' {
  interface SessionData {
    plex?: {
      authToken?: string;
      clientId?: string;
      serverId?: string;
      serverName?: string;
      serverUri?: string;
      serverToken?: string;
      libraryId?: string;
      libraryTitle?: string;
    };
  }
}
