import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../utils/database';

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '../../data/output');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads');
const MUSIC_DIR = process.env.MUSIC_DIR || '/music';

const PHOTO_DURATION = parseInt(process.env.PHOTO_DURATION_SECONDS || '4');
const TRANSITION_DURATION = parseFloat(process.env.TRANSITION_DURATION_SECONDS || '1');

interface VideoJob {
  sessionId: string;
  musicFiles: string[];
  plex?: {
    serverUri: string;
    token: string;
    clientId?: string;
  };
  onProgress?: (progress: number) => void;
  onComplete?: (outputPath: string) => void;
  onError?: (error: Error) => void;
}

export class VideoGenerator {
  constructor() {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  }

  async createVideo(job: VideoJob): Promise<string> {
    const database = db.get();
    
    // Get selected photos for this session
    const photos = database.prepare(`
      SELECT * FROM photos 
      WHERE session_id = ? AND is_selected = 1
      ORDER BY creation_time ASC
    `).all(job.sessionId) as any[];

    if (photos.length === 0) {
      throw new Error('No photos selected for video');
    }

    const videoId = uuidv4();
    const outputPath = path.join(OUTPUT_DIR, `${videoId}.mp4`);
    const tempDir = path.join(OUTPUT_DIR, videoId);
    
    try {
      // Create temp directory
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Create video in database
      database.prepare(`
        INSERT INTO videos (id, session_id, status, output_path)
        VALUES (?, ?, 'processing', ?)
      `).run(videoId, job.sessionId, outputPath);

      // Prepare photos (normalize to same size)
      console.log(`Preparing ${photos.length} photos...`);
      const preparedPhotos = await this.preparePhotos(photos, tempDir);

      // Concatenate music files
      console.log('Processing audio...');
      const audioPath = await this.prepareAudio(job.musicFiles, tempDir, photos.length, job.plex);

      // Build ffmpeg command for slideshow
      console.log('Generating video...');
      await this.buildSlideshow(preparedPhotos, audioPath, outputPath, job);

      // Update video status
      const stats = fs.statSync(outputPath);
      database.prepare(`
        UPDATE videos 
        SET status = 'complete', file_size = ?
        WHERE id = ?
      `).run(stats.size, videoId);

      // Cleanup temp files
      this.cleanup(tempDir);

      job.onComplete?.(outputPath);
      return outputPath;

    } catch (error) {
      database.prepare(`
        UPDATE videos SET status = 'error' WHERE id = ?
      `).run(videoId);
      
      this.cleanup(tempDir);
      job.onError?.(error as Error);
      throw error;
    }
  }

  private async preparePhotos(photos: any[], tempDir: string): Promise<string[]> {
    const prepared: string[] = [];
    
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const outputPath = path.join(tempDir, `photo_${i.toString().padStart(4, '0')}.jpg`);
      
      // Copy and optimize photo
      await new Promise<void>((resolve, reject) => {
        ffmpeg(photo.downloaded_path)
          .outputOptions([
            '-vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black'
          ])
          .frames(1)
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', reject)
          .run();
      });
      
      prepared.push(outputPath);
    }
    
    return prepared;
  }

  private async prepareAudio(
    musicFiles: string[],
    tempDir: string,
    photoCount: number,
    plex?: { serverUri: string; token: string; clientId?: string }
  ): Promise<string> {
    // Calculate required duration
    const requiredDuration = photoCount * (PHOTO_DURATION + TRANSITION_DURATION);
    const outputPath = path.join(tempDir, 'audio.mp3');
    
    const resolvedFiles = await this.resolveMusicFiles(musicFiles, tempDir, plex);

    if (resolvedFiles.length === 1) {
      // Single file - check if we need to loop it
      const finalMusicPath = resolvedFiles[0];
      
      // Get duration of music file
      const duration = await this.getAudioDuration(finalMusicPath);
      
      if (duration < requiredDuration) {
        // Create looped audio
        const loopCount = Math.ceil(requiredDuration / duration);
        const concatFile = path.join(tempDir, 'concat.txt');
        
        let concatContent = '';
        for (let i = 0; i < loopCount; i++) {
          concatContent += `file '${finalMusicPath.replace(/'/g, "'\\''")}'\n`;
        }
        fs.writeFileSync(concatFile, concatContent);
        
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(concatFile)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-acodec libmp3lame', '-q:a 2'])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        });
      } else {
        // Trim audio to required duration
        await new Promise<void>((resolve, reject) => {
          ffmpeg(finalMusicPath)
            .seekInput(0)
            .duration(requiredDuration)
            .outputOptions(['-acodec libmp3lame', '-q:a 2'])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        });
      }
    } else {
      // Multiple files - concatenate
      const concatFile = path.join(tempDir, 'concat.txt');
      let concatContent = '';
      
      for (const finalPath of resolvedFiles) {
        concatContent += `file '${finalPath.replace(/'/g, "'\\''")}'\n`;
      }
      fs.writeFileSync(concatFile, concatContent);
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(concatFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-acodec libmp3lame', '-q:a 2'])
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', reject)
          .run();
      });
    }
    
    // Trim to exact duration
    const finalOutput = path.join(tempDir, 'audio_trimmed.mp3');
    await new Promise<void>((resolve, reject) => {
      ffmpeg(outputPath)
        .seekInput(0)
        .duration(requiredDuration)
        .outputOptions(['-acodec libmp3lame', '-q:a 2'])
        .output(finalOutput)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });
    
    return finalOutput;
  }

  private async buildSlideshow(
    photos: string[], 
    audioPath: string, 
    outputPath: string,
    job: VideoJob
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build complex filter for crossfade between images
      let filterComplex = '';
      let currentOverlay = '[0:v]';
      
      for (let i = 0; i < photos.length - 1; i++) {
        const next = i + 1;
        
        // Each image fades out over transition period
        filterComplex += `[${i}:v]format=pix_fmts=yuv420p[f${i}];`;
        
        if (i === 0) {
          filterComplex += `[f${i}][${next}:v]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${PHOTO_DURATION}[v${next}];`;
        } else {
          filterComplex += `[v${i}][${next}:v]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${(i + 1) * PHOTO_DURATION}[v${next}];`;
        }
        
        currentOverlay = `[v${next}]`;
      }
      
      // Format final video
      filterComplex += `${currentOverlay}format=pix_fmts=yuv420p[video];`;
      
      // Build inputs
      const cmd = ffmpeg();
      photos.forEach(photo => cmd.input(photo));
      cmd.input(audioPath);
      
      cmd
        .complexFilter(filterComplex, currentOverlay.replace(/[\[\]]/g, ''))
        .outputOptions([
          '-map [video]',
          '-map ' + photos.length + ':a',
          '-c:v libx264',
          '-preset medium',
          '-crf 23',
          '-c:a aac',
          '-b:a 192k',
          '-shortest',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', (cmd) => {
          console.log('FFmpeg command:', cmd);
        })
        .on('progress', (progress) => {
          console.log('Processing: ' + progress.percent?.toFixed(2) + '% done');
          job.onProgress?.(progress.percent || 0);
        })
        .on('end', () => {
          console.log('Video created:', outputPath);
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .run();
    });
  }

  private async getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }

  private async resolveMusicFiles(
    musicFiles: string[],
    tempDir: string,
    plex?: { serverUri: string; token: string; clientId?: string }
  ): Promise<string[]> {
    const resolved: string[] = [];

    for (const file of musicFiles) {
      if (file.startsWith('plex:')) {
        if (!plex?.serverUri || !plex.token) {
          throw new Error('Plex track selected but Plex is not connected');
        }
        const ratingKey = file.replace('plex:', '');
        const downloaded = await this.downloadPlexTrack(ratingKey, tempDir, plex);
        resolved.push(downloaded);
        continue;
      }

      const uploadPath = path.join(UPLOAD_DIR, file);
      const finalPath = fs.existsSync(uploadPath) ? uploadPath : path.join(MUSIC_DIR, file);
      resolved.push(finalPath);
    }

    return resolved;
  }

  private async downloadPlexTrack(
    ratingKey: string,
    tempDir: string,
    plex: { serverUri: string; token: string; clientId?: string }
  ): Promise<string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Plex-Token': plex.token
    };
    if (plex.clientId) headers['X-Plex-Client-Identifier'] = plex.clientId;

    const metaRes = await fetch(`${plex.serverUri}/library/metadata/${ratingKey}`, { headers });
    const meta = await metaRes.json() as any;
    const media = meta.MediaContainer?.Metadata?.[0]?.Media?.[0];
    const partKey = media?.Part?.[0]?.key;
    if (!partKey) throw new Error('Unable to resolve Plex media path');

    const streamRes = await fetch(`${plex.serverUri}${partKey}`, {
      headers: {
        'X-Plex-Token': plex.token
      }
    });

    if (!streamRes.ok || !streamRes.body) {
      throw new Error('Failed to download Plex track');
    }

    const outputPath = path.join(tempDir, `plex_${ratingKey}.mp3`);
    await new Promise<void>((resolve, reject) => {
      const fileStream = fs.createWriteStream(outputPath);
      streamRes.body.pipe(fileStream);
      streamRes.body.on('error', reject);
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });

    return outputPath;
  }

  private cleanup(dirPath: string) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }
}

export const videoGenerator = new VideoGenerator();
