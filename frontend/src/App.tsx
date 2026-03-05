import { useState, useEffect } from 'react'

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [currentStep, setCurrentStep] = useState('auth');
  const [session, setSession] = useState<any>(null);
  const [albums, setAlbums] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [musicFiles, setMusicFiles] = useState<any[]>([]);
  const [uploadedMusic, setUploadedMusic] = useState<any[]>([]);
  const [selectedMusic, setSelectedMusic] = useState<string[]>([]);
  const [video, setVideo] = useState<any>(null);

  useEffect(() => {
    checkAuth();
    if (window.location.search.includes('auth=success')) {
      window.history.replaceState({}, '', '/');
      checkAuth();
    }
  }, []);

  const checkAuth = async () => {
    try {
      const res = await fetch('/auth/status', { credentials: 'include' });
      const data = await res.json();
      if (data.authenticated) {
        setAuthenticated(true);
        setUser(data.user);
        loadAlbums();
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
  };

  const loadAlbums = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/photos/albums', { credentials: 'include' });
      const data = await res.json();
      setAlbums(data.albums || []);
      setCurrentStep('albums');
    } catch (err) {
      console.error('Failed to load albums:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectAlbum = async (albumId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/photos/album/${albumId}`, { credentials: 'include' });
      const data = await res.json();
      
      // Process photos (deduplicate)
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
    } catch (err) {
      console.error('Failed to select album:', err);
    } finally {
      setLoading(false);
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
    } catch (err) {
      console.error('Failed to load music:', err);
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
        if (data.status === 'complete' || data.status === 'error') {
          clearInterval(interval);
          setCurrentStep('complete');
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
            <p>Create beautiful slideshow videos from your Google Photos albums</p>
            <button onClick={login} className="btn btn-primary" style={{ marginTop: '20px' }}>
              Connect Google Photos
            </button>
          </div>
        ) : loading ? (
          <div className="card loading">
            <div className="loading-spinner"></div>
            <p>Working...</p>
          </div>
        ) : currentStep === 'albums' ? (
          <div className="card">
            <h2>Select an Album</h2>
            <div className="album-grid">
              {albums.map(album => (
                <div key={album.id} className="album-card" onClick={() => selectAlbum(album.id)}>
                  <div className="album-thumb">
                    {album.coverPhotoBaseUrl ? (
                      <img src={`${album.coverPhotoBaseUrl}=w200-h200`} alt="" />
                    ) : (
                      <span style={{ fontSize: '2rem' }}>📁</span>
                    )}
                  </div>
                  <h3>{album.title || 'Untitled'}</h3>
                  <span>{album.mediaItemsCount} photos</span>
                </div>
              ))}
            </div>
          </div>
        ) : currentStep === 'photos' ? (
          <>
            <div className="card">
              <h2>{session?.albumTitle}</h2>
              <p style={{ color: 'var(--text-muted)' }}>
                Original: {session?.photoCount} photos • 
                Selected: {session?.selectedCount} photos •
                Duplicates removed: {session?.duplicateCount}
              </p>
              <p style={{ marginTop: '12px', fontWeight: 500 }}>
                You need approximately <strong>{session?.requiredMusicMinutes} minutes</strong> of music
              </p>
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
                setCurrentStep('albums');
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
