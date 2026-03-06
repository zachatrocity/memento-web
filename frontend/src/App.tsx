import { useState, useEffect, useRef } from 'react'

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [currentStep, setCurrentStep] = useState('auth');
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Working...');
  const [musicFiles, setMusicFiles] = useState<any[]>([]);
  const [uploadedMusic, setUploadedMusic] = useState<any[]>([]);
  const [selectedMusic, setSelectedMusic] = useState<string[]>([]);
  const [video, setVideo] = useState<any>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [pickerSession, setPickerSession] = useState<any>(null);
  const [plexStatus, setPlexStatus] = useState<any>(null);
  const [plexPinId, setPlexPinId] = useState<string | null>(null);
  const [plexServers, setPlexServers] = useState<any[]>([]);
  const [plexLibraries, setPlexLibraries] = useState<any[]>([]);
  const [plexTracks, setPlexTracks] = useState<any[]>([]);
  const [plexSearchQuery, setPlexSearchQuery] = useState('');
  const [isSearchingPlex, setIsSearchingPlex] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const plexPollingRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    checkAuth();
    if (window.location.search.includes('auth=success')) {
      window.history.replaceState({}, '', '/');
      checkAuth();
    }
    
    // Cleanup polling on unmount
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
      if (plexPollingRef.current) {
        clearInterval(plexPollingRef.current);
      }
    };
  }, []);

  const checkAuth = async () => {
    try {
      const res = await fetch('/auth/status', { credentials: 'include' });
      const data = await res.json();
      if (data.authenticated) {
        setAuthenticated(true);
        setUser(data.user);
        setCurrentStep('picker');
      }
    } catch (err) {
      console.error('Auth check failed:', err);
    }
  };

  const login = async () => {
    const res = await fetch('/auth/url');
    const data = await res.json();
    window.location.href = data.url;
  };

  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthenticated(false);
    setUser(null);
    setCurrentStep('auth');
    setPickerSession(null);
    setSession(null);
    setPlexStatus(null);
    setPlexServers([]);
    setPlexLibraries([]);
    setPlexTracks([]);
  };

  // Start the Google Photos Picker flow
  const startPhotoPicker = async () => {
    setLoading(true);
    setLoadingMessage('Creating photo picker session...');
    try {
      const res = await fetch('/api/photos/picker/session', { 
        method: 'POST',
        credentials: 'include' 
      });
      const data = await res.json();
      
      if (data.error) {
        console.error('Failed to create picker session:', data);
        alert(`Error: ${data.details?.message || data.error}`);
        setLoading(false);
        return;
      }
      
      setPickerSession(data);
      
      // Open the picker URL in a new window
      const pickerWindow = window.open(data.pickerUrl, 'photoPicker', 'width=800,height=600');
      
      // Start polling for completion
      setLoadingMessage('Waiting for you to select photos...');
      pollingRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/photos/picker/session/${data.sessionId}`, {
            credentials: 'include'
          });
          const pollData = await pollRes.json();
          
          if (pollData.mediaItemsSet) {
            // User has selected photos
            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
            
            // Close the picker window if still open
            if (pickerWindow && !pickerWindow.closed) {
              pickerWindow.close();
            }
            
            // Import the selected photos
            await importPhotos(data.sessionId);
          }
        } catch (err) {
          console.error('Polling error:', err);
        }
      }, 2000); // Poll every 2 seconds
      
    } catch (err) {
      console.error('Failed to start photo picker:', err);
      setLoading(false);
    }
  };

  // Import photos from the picker session
  const importPhotos = async (pickerSessionId: string) => {
    setLoadingMessage('Importing selected photos...');
    try {
      const res = await fetch('/api/photos/picker/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickerSessionId })
      });
      const data = await res.json();
      
      if (data.error) {
        console.error('Failed to import photos:', data);
        alert(`Error: ${data.details?.message || data.error}`);
        setLoading(false);
        return;
      }
      
      // Process photos (deduplicate)
      setLoadingMessage('Processing photos...');
      const processRes = await fetch('/api/photos/process', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: data.sessionId })
      });
      const processData = await processRes.json();
      
      setSession({ ...data, ...processData });
      setCurrentStep('photos');
      loadMusic();
      
      // Clean up the picker session
      try {
        await fetch(`/api/photos/picker/session/${pickerSessionId}`, {
          method: 'DELETE',
          credentials: 'include'
        });
      } catch (err) {
        // Ignore cleanup errors
      }
      
    } catch (err) {
      console.error('Failed to import photos:', err);
    } finally {
      setLoading(false);
      setPickerSession(null);
    }
  };

  const loadMusic = async () => {
    try {
      const [libRes, uploadRes] = await Promise.all([
        fetch('/api/music/library', { credentials: 'include' }),
        fetch('/api/music/uploaded', { credentials: 'include' })
      ]);
      const libData = await libRes.json();
      const uploadData = await uploadRes.json();
      setMusicFiles(libData.files || []);
      setUploadedMusic(uploadData.files || []);
      await loadPlexStatus();
    } catch (err) {
      console.error('Failed to load music:', err);
    }
  };

  const loadPlexStatus = async () => {
    try {
      const res = await fetch('/api/music/plex/status', { credentials: 'include' });
      const data = await res.json();
      setPlexStatus(data);
      if (data.authenticated) {
        await loadPlexServers();
        if (data.libraryId) {
          await loadPlexTracks(data.libraryId);
        } else if (data.serverId) {
          await loadPlexLibraries();
        }
      }
    } catch (err) {
      console.error('Failed to load Plex status:', err);
    }
  };

  const startPlexAuth = async () => {
    try {
      const res = await fetch('/api/music/plex/pin', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      setPlexPinId(String(data.pinId));
      window.open(data.authUrl, 'plexAuth', 'width=900,height=700');
      plexPollingRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/music/plex/pin/${data.pinId}`, {
            credentials: 'include'
          });
          const pollData = await pollRes.json();
          if (pollData.authenticated) {
            if (plexPollingRef.current) clearInterval(plexPollingRef.current);
            setPlexPinId(null);
            await loadPlexStatus();
          }
        } catch (err) {
          console.error('Plex polling failed:', err);
        }
      }, 2000);
    } catch (err) {
      console.error('Failed to start Plex auth:', err);
    }
  };

  const loadPlexServers = async () => {
    try {
      const res = await fetch('/api/music/plex/servers', { credentials: 'include' });
      const data = await res.json();
      setPlexServers(data.servers || []);
    } catch (err) {
      console.error('Failed to load Plex servers:', err);
    }
  };

  const selectPlexServer = async (server: any) => {
    await fetch('/api/music/plex/servers/select', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: server.id,
        serverName: server.name,
        serverUri: server.uri,
        serverToken: server.token
      })
    });
    await loadPlexStatus();
    await loadPlexLibraries();
  };

  const loadPlexLibraries = async () => {
    try {
      const res = await fetch('/api/music/plex/libraries', { credentials: 'include' });
      const data = await res.json();
      setPlexLibraries(data.libraries || []);
    } catch (err) {
      console.error('Failed to load Plex libraries:', err);
    }
  };

  const selectPlexLibrary = async (library: any) => {
    await fetch('/api/music/plex/libraries/select', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        libraryId: library.id,
        libraryTitle: library.title
      })
    });
    await loadPlexStatus();
    await loadPlexTracks(library.id);
  };

  const loadPlexTracks = async (libraryId: string, searchQuery?: string) => {
    try {
      setIsSearchingPlex(true);
      let url = `/api/music/plex/library/${libraryId}/tracks`;
      if (searchQuery) {
        url += `?search=${encodeURIComponent(searchQuery)}`;
      }
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      setPlexTracks(data.tracks || []);
    } catch (err) {
      console.error('Failed to load Plex tracks:', err);
    } finally {
      setIsSearchingPlex(false);
    }
  };

  const searchPlexTracks = async (query: string) => {
    if (plexStatus?.libraryId) {
      await loadPlexTracks(plexStatus.libraryId, query);
    }
  };

  const handleMusicUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    
    const formData = new FormData();
    for (const file of files) {
      formData.append('music', file);
    }
    
    setLoading(true);
    setLoadingMessage('Uploading music...');
    try {
      await fetch('/api/music/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      loadMusic();
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleMusicSelection = (path: string) => {
    setSelectedMusic(prev => 
      prev.includes(path) 
        ? prev.filter(p => p !== path)
        : [...prev, path]
    );
  };

  const createVideo = async () => {
    setLoading(true);
    setLoadingMessage('Creating video...');
    try {
      const res = await fetch('/api/video/create', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          musicFiles: selectedMusic
        })
      });
      const data = await res.json();
      
      if (data.success) {
        setVideo({ id: data.videoId, status: 'processing' });
        setCurrentStep('processing');
        pollVideoStatus(data.videoId);
      }
    } catch (err) {
      console.error('Failed to create video:', err);
    } finally {
      setLoading(false);
    }
  };

  const pollVideoStatus = async (videoId: string) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status/${videoId}`, { credentials: 'include' });
        const data = await res.json();
        setVideo(data);
        if (data.status === 'complete') {
          clearInterval(interval);
          setCurrentStep('complete');
        } else if (data.status === 'error') {
          clearInterval(interval);
          setVideoError('Video generation failed. Please try again.');
          setCurrentStep('error');
        }
      } catch (err) {
        console.error('Status poll failed:', err);
      }
    }, 2000);
  };

  return (
    <div className="app">
      <header>
        <div className="container">
          <div className="logo">Memento</div>
          {authenticated && user && (
            <div className="user-menu">
              <span>{user.email}</span>
              <button onClick={logout} className="btn btn-secondary">Logout</button>
            </div>
          )}
        </div>
      </header>

      <main className="container">
        {!authenticated ? (
          <div className="card empty-state">
            <h1>Welcome to Memento</h1>
            <p>Create beautiful slideshow videos from your Google Photos</p>
            <button onClick={login} className="btn btn-primary" style={{ marginTop: '20px' }}>
              Connect Google Photos
            </button>
          </div>
        ) : loading ? (
          <div className="card loading">
            <div className="loading-spinner"></div>
            <p>{loadingMessage}</p>
            {pickerSession && (
              <p style={{ marginTop: '12px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                A new window should have opened for you to select photos.<br/>
                If not, <a href={pickerSession.pickerUrl} target="_blank" rel="noopener noreferrer">click here</a>.
              </p>
            )}
          </div>
        ) : currentStep === 'picker' ? (
          <div className="card empty-state">
            <h2>Select Photos & Videos</h2>
            <p>Click the button below to open Google Photos and select photos and videos you want to include in your slideshow.</p>
            <button onClick={startPhotoPicker} className="btn btn-primary" style={{ marginTop: '20px' }}>
              Select Media from Google Photos
            </button>
          </div>
        ) : currentStep === 'photos' ? (
          <>
            <div className="card">
              <h2>Selected Media</h2>
              <p style={{ color: 'var(--text-muted)' }}>
                {session?.photoCount > 0 && `${session?.photoCount} photos `}
                {session?.videoCount > 0 && `${session?.videoCount} videos `}
                • 
                Selected: {session?.selectedCount} photos •
                Duplicates removed: {session?.duplicateCount}
              </p>
              <p style={{ marginTop: '12px', fontWeight: 500 }}>
                You need approximately <strong>{session?.requiredMusicMinutes} minutes</strong> of music
              </p>
              <button 
                onClick={() => setCurrentStep('picker')} 
                className="btn btn-secondary"
                style={{ marginTop: '12px' }}
              >
                Select Different Photos
              </button>
            </div>

            <div className="card">
              <h2>Add Music</h2>
              
              <div className="form-group" style={{ marginTop: '16px' }}>
                <label>Upload Music Files</label>
                <input 
                  type="file" 
                  accept="audio/*" 
                  multiple 
                  onChange={handleMusicUpload}
                />
              </div>

              <h3 style={{ marginTop: '20px', fontSize: '1rem' }}>Plex Music</h3>
              {!plexStatus?.authenticated ? (
                <div style={{ marginTop: '12px' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={startPlexAuth}
                    disabled={!!plexPinId}
                  >
                    {plexPinId ? 'Waiting for Plex authorization...' : 'Connect Plex'}
                  </button>
                </div>
              ) : (
                <>
                  <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
                    Connected{plexStatus?.serverName ? ` • ${plexStatus.serverName}` : ''}
                  </p>
                  {plexServers.length > 0 && (
                    <>
                      <h4 style={{ marginTop: '12px', fontSize: '0.95rem' }}>Choose Server</h4>
                      <div className="music-list">
                        {plexServers.map((server: any) => (
                          <div
                            key={server.id}
                            className={`music-item ${plexStatus?.serverId === server.id ? 'selected' : ''}`}
                            onClick={() => selectPlexServer(server)}
                          >
                            <input
                              type="checkbox"
                              checked={plexStatus?.serverId === server.id}
                              onChange={() => {}}
                            />
                            <span>{server.name}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {plexLibraries.length > 0 && (
                    <>
                      <h4 style={{ marginTop: '12px', fontSize: '0.95rem' }}>Choose Library</h4>
                      <div className="music-list">
                        {plexLibraries.map((library: any) => (
                          <div
                            key={library.id}
                            className={`music-item ${plexStatus?.libraryId === library.id ? 'selected' : ''}`}
                            onClick={() => selectPlexLibrary(library)}
                          >
                            <input
                              type="checkbox"
                              checked={plexStatus?.libraryId === library.id}
                              onChange={() => {}}
                            />
                            <span>{library.title}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {plexStatus?.libraryId && (
                    <>
                      <h4 style={{ marginTop: '12px', fontSize: '0.95rem' }}>Choose Tracks</h4>
                      <div style={{ marginTop: '8px', marginBottom: '12px' }}>
                        <input
                          type="text"
                          placeholder="Search tracks or artists..."
                          value={plexSearchQuery}
                          onChange={(e) => {
                            setPlexSearchQuery(e.target.value);
                            searchPlexTracks(e.target.value);
                          }}
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            border: '1px solid var(--border)',
                            borderRadius: '6px',
                            fontSize: '0.9rem'
                          }}
                        />
                      </div>
                      {isSearchingPlex && (
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Searching...</p>
                      )}
                      <div className="music-list" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                        {plexTracks.length === 0 && !isSearchingPlex && (
                          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', padding: '12px' }}>
                            {plexSearchQuery ? 'No tracks found' : 'Type to search for tracks'}
                          </p>
                        )}
                        {plexTracks.map((track: any) => {
                          const key = `plex:${track.ratingKey}`;
                          const label = track.artist ? `${track.artist} — ${track.title}` : track.title;
                          return (
                            <div
                              key={track.ratingKey}
                              className={`music-item ${selectedMusic.includes(key) ? 'selected' : ''}`}
                              onClick={() => toggleMusicSelection(key)}
                            >
                              <input
                                type="checkbox"
                                checked={selectedMusic.includes(key)}
                                onChange={() => {}}
                              />
                              <span>{label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}

              {musicFiles.length > 0 && (
                <>
                  <h3 style={{ marginTop: '20px', fontSize: '1rem' }}>From Music Library</h3>
                  <div className="music-list">
                    {musicFiles.map((file: any) => (
                      <div 
                        key={file.path} 
                        className={`music-item ${selectedMusic.includes(file.path) ? 'selected' : ''}`}
                        onClick={() => toggleMusicSelection(file.path)}
                      >
                        <input 
                          type="checkbox" 
                          checked={selectedMusic.includes(file.path)}
                          onChange={() => {}}
                        />
                        <span>{file.name}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {uploadedMusic.length > 0 && (
                <>
                  <h3 style={{ marginTop: '20px', fontSize: '1rem' }}>Uploaded Files</h3>
                  <div className="music-list">
                    {uploadedMusic.map((file: any) => (
                      <div 
                        key={file.name}
                        className={`music-item ${selectedMusic.includes(file.name) ? 'selected' : ''}`}
                        onClick={() => toggleMusicSelection(file.name)}
                      >
                        <input 
                          type="checkbox" 
                          checked={selectedMusic.includes(file.name)}
                          onChange={() => {}}
                        />
                        <span>{file.name}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <button 
                className="btn btn-primary" 
                style={{ marginTop: '20px' }}
                disabled={selectedMusic.length === 0}
                onClick={createVideo}
              >
                Create Video
              </button>
            </div>
          </>
        ) : currentStep === 'processing' ? (
          <div className="card">
            <h2>Creating Your Video</h2>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '60%' }}></div>
            </div>
            <p style={{ color: 'var(--text-muted)' }}>
              {video?.status === 'processing' ? 'This may take a few minutes...' : 'Almost done!'}
            </p>
          </div>
        ) : currentStep === 'error' ? (
          <div className="card">
            <h2>Video Generation Failed</h2>
            <p style={{ color: 'var(--error)', marginTop: '12px' }}>
              {video?.errorMessage || videoError || 'Something went wrong while creating your video.'}
            </p>
            <button 
              className="btn btn-primary" 
              style={{ marginTop: '20px', width: '100%' }}
              onClick={() => {
                setCurrentStep('photos');
                setVideoError(null);
              }}
            >
              Try Again
            </button>
          </div>
        ) : currentStep === 'complete' ? (
          <div className="card">
            <h2>Your Video is Ready!</h2>
            {video?.downloadUrl && (
              <div style={{ marginTop: '20px' }}>
                <video src={video.downloadUrl} controls />
                <a 
                  href={video.downloadUrl} 
                  download 
                  className="btn btn-primary" 
                  style={{ marginTop: '16px', width: '100%', justifyContent: 'center' }}
                >
                  Download Video
                </a>
              </div>
            )}
            <button 
              className="btn btn-secondary" 
              style={{ marginTop: '12px', width: '100%' }}
              onClick={() => {
                setCurrentStep('picker');
                setSession(null);
                setVideo(null);
              }}
            >
              Create Another
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App
